use crate::models::SearchHit;
use anyhow::{bail, Result};
use std::cmp::{Ordering, Reverse};
use std::collections::BinaryHeap;
use std::time::{Duration, Instant};

pub(crate) const EMBEDDING_PAGE_ROWS: usize = 128;
pub(crate) const EMBEDDING_PAGE_BYTES: usize = 1024 * 1024;
pub(crate) const MAX_EMBEDDING_DIMENSIONS: usize = 16_384;

#[derive(Clone, Debug)]
pub(crate) struct EmbeddingSearchScope {
    pub model: String,
    pub dimensions: usize,
    pub exclude_recording_id: Option<String>,
    pub source_type: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct EmbeddingScanToken {
    pub revision: i64,
    pub upper_id: Option<i64>,
}

#[derive(Debug)]
pub(crate) struct RawEmbeddingRow {
    pub id: i64,
    pub created_at: String,
    pub embedding: Vec<u8>,
    pub hit: SearchHit,
}

#[derive(Debug)]
pub(crate) struct EmbeddingScanPage {
    pub rows: Vec<RawEmbeddingRow>,
    pub next_cursor: Option<i64>,
    pub exhausted: bool,
}

#[derive(Debug)]
struct RankedHit {
    id: i64,
    created_at: String,
    hit: SearchHit,
}

impl PartialEq for RankedHit {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}
impl Eq for RankedHit {}
impl PartialOrd for RankedHit {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for RankedHit {
    fn cmp(&self, other: &Self) -> Ordering {
        self.hit
            .score
            .total_cmp(&other.hit.score)
            .then_with(|| self.created_at.cmp(&other.created_at))
            .then_with(|| self.id.cmp(&other.id))
    }
}

pub(crate) struct SemanticRanker {
    query: Vec<f64>,
    query_norm: f64,
    limit: usize,
    best: BinaryHeap<Reverse<RankedHit>>,
}

impl SemanticRanker {
    pub(crate) fn new(query: &[f32], limit: usize) -> Result<Self> {
        if query.is_empty()
            || query.len() > MAX_EMBEDDING_DIMENSIONS
            || query.iter().any(|value| !value.is_finite())
        {
            bail!("The semantic query vector is invalid.");
        }
        if limit > 1_000 {
            bail!("Too many semantic search results were requested.");
        }
        let query: Vec<f64> = query.iter().map(|value| f64::from(*value)).collect();
        let query_norm = query.iter().map(|value| value * value).sum::<f64>().sqrt();
        Ok(Self {
            query,
            query_norm,
            limit,
            best: BinaryHeap::new(),
        })
    }

    pub(crate) fn push(&mut self, mut row: RawEmbeddingRow) {
        if self.limit == 0
            || row.embedding.len() != self.query.len() * 4
            || !row.hit.start_time.is_finite()
            || !row.hit.end_time.is_finite()
            || row.hit.start_time < 0.0
            || row.hit.end_time < row.hit.start_time
        {
            return;
        }
        let mut dot = 0.0;
        let mut norm = 0.0;
        for (bytes, query) in row.embedding.chunks_exact(4).zip(&self.query) {
            let value = f64::from(f32::from_le_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]));
            if !value.is_finite() {
                return;
            }
            dot += value * query;
            norm += value * value;
        }
        let score = if norm == 0.0 || self.query_norm == 0.0 {
            0.0
        } else {
            (dot / (norm.sqrt() * self.query_norm)).clamp(-1.0, 1.0)
        };
        if !score.is_finite() {
            return;
        }
        row.hit.score = if score == 0.0 { 0.0 } else { score };
        let candidate = RankedHit {
            id: row.id,
            created_at: row.created_at,
            hit: row.hit,
        };
        if self.best.len() < self.limit {
            self.best.push(Reverse(candidate));
        } else if self.best.peek().is_some_and(|worst| candidate > worst.0) {
            self.best.pop();
            self.best.push(Reverse(candidate));
        }
    }

    pub(crate) fn finish(self) -> Vec<SearchHit> {
        let mut hits: Vec<_> = self.best.into_iter().map(|value| value.0).collect();
        hits.sort_by(|a, b| b.cmp(a));
        hits.into_iter().map(|value| value.hit).collect()
    }
}

pub(crate) async fn search_embeddings_shared(
    database: &tokio::sync::Mutex<crate::db::Database>,
    query: &[f32],
    limit: usize,
    model: &str,
    exclude_recording_id: Option<&str>,
    source_type: Option<&str>,
) -> Result<Vec<SearchHit>> {
    SemanticRanker::new(query, limit)?;
    if limit == 0 {
        return Ok(Vec::new());
    }
    let scope = EmbeddingSearchScope {
        model: model.to_string(),
        dimensions: query.len(),
        exclude_recording_id: exclude_recording_id.map(str::to_string),
        source_type: source_type.map(str::to_string),
    };
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut previous_error = None;
    for _ in 0..2 {
        let result = scan_once(
            database,
            &scope,
            SemanticRanker::new(query, limit)?,
            deadline,
        )
        .await;
        match result {
            Ok(hits) => return Ok(hits),
            Err(error) => previous_error = Some(error),
        }
        if Instant::now() >= deadline {
            break;
        }
        tokio::task::yield_now().await;
    }
    Err(previous_error.expect("Both scan attempts returned an error"))
}

async fn scan_once(
    database: &tokio::sync::Mutex<crate::db::Database>,
    scope: &EmbeddingSearchScope,
    mut ranker: SemanticRanker,
    deadline: Instant,
) -> Result<Vec<SearchHit>> {
    let token = {
        tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), database.lock())
            .await
            .map_err(|_| anyhow::anyhow!("Semantic search timed out waiting for the database."))?
            .begin_embedding_scan(scope)?
    };
    let mut cursor = None;
    loop {
        if Instant::now() >= deadline {
            bail!("Semantic search exceeded its time budget; no partial result was used.");
        }
        let page = {
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), database.lock())
                .await
                .map_err(|_| {
                    anyhow::anyhow!("Semantic search timed out waiting for the database.")
                })?
                .read_embedding_scan_page(scope, &token, cursor)?
        };
        for (index, row) in page.rows.into_iter().enumerate() {
            ranker.push(row);
            if index % 32 == 31 {
                tokio::task::yield_now().await;
                if Instant::now() >= deadline {
                    bail!("Semantic search exceeded its time budget; no partial result was used.");
                }
            }
        }
        if Instant::now() >= deadline {
            bail!("Semantic search exceeded its time budget; no partial result was used.");
        }
        if page.exhausted {
            tokio::time::timeout_at(tokio::time::Instant::from_std(deadline), database.lock())
                .await
                .map_err(|_| {
                    anyhow::anyhow!("Semantic search timed out waiting for the database.")
                })?
                .validate_embedding_scan(&token)?;
            if Instant::now() >= deadline {
                bail!("Semantic search exceeded its time budget; no partial result was used.");
            }
            return Ok(ranker.finish());
        }
        if page.next_cursor == cursor {
            bail!("Semantic search did not advance; no partial result was used.");
        }
        cursor = page.next_cursor;
        tokio::task::yield_now().await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::future::{poll_fn, Future};
    use std::pin::Pin;
    use std::task::Poll;

    async fn poll_once<F: Future>(mut future: Pin<&mut F>) -> Poll<F::Output> {
        poll_fn(|context| Poll::Ready(future.as_mut().poll(context))).await
    }

    fn row(id: i64, vector: &[f32], date: &str) -> RawEmbeddingRow {
        RawEmbeddingRow {
            id,
            created_at: date.to_string(),
            embedding: vector
                .iter()
                .flat_map(|value| value.to_le_bytes())
                .collect(),
            hit: SearchHit {
                recording_id: "meeting".into(),
                recording_title: "Design review".into(),
                project_id: String::new(),
                segment_id: id.to_string(),
                text: format!("Evidence {id}"),
                start_time: 0.0,
                end_time: 1.0,
                score: 0.0,
            },
        }
    }

    #[test]
    fn semantic_ranker_keeps_best_evidence_with_stable_ties() {
        for order in [vec![1, 2, 3, 4], vec![4, 3, 2, 1]] {
            let mut ranker = SemanticRanker::new(&[1.0, 0.0], 3).unwrap();
            for id in order {
                let date = if id < 3 { "2026-01-01" } else { "2026-10-01" };
                let vector = if id == 1 { [1.0, 0.0] } else { [0.8, 0.2] };
                ranker.push(row(id, &vector, date));
            }
            let hits = ranker.finish();
            assert_eq!(
                hits.iter()
                    .map(|hit| hit.segment_id.as_str())
                    .collect::<Vec<_>>(),
                vec!["1", "4", "3"]
            );
        }
    }

    #[test]
    fn semantic_ranker_rejects_corrupt_candidates_and_scores_extreme_finite_vectors() {
        let mut ranker = SemanticRanker::new(&[f32::MAX, f32::MAX], 10).unwrap();
        ranker.push(row(1, &[f32::NAN, 0.0], "2026-10-01"));
        ranker.push(row(2, &[f32::INFINITY, 0.0], "2026-10-01"));
        ranker.push(row(3, &[1.0], "2026-10-01"));
        let mut corrupt_bytes = row(4, &[1.0, 0.0], "2026-10-01");
        corrupt_bytes.embedding.push(0);
        ranker.push(corrupt_bytes);
        for start in [f64::NAN, -1.0, 2.0] {
            let mut corrupt_time = row(5, &[1.0, 0.0], "2026-10-01");
            corrupt_time.hit.start_time = start;
            ranker.push(corrupt_time);
        }
        ranker.push(row(6, &[f32::MAX, f32::MAX], "2026-01-01"));
        ranker.push(row(7, &[0.0, 0.0], "2026-10-01"));
        let hits = ranker.finish();
        assert_eq!(
            hits.iter()
                .map(|hit| hit.segment_id.as_str())
                .collect::<Vec<_>>(),
            vec!["6", "7"]
        );
        assert!((hits[0].score - 1.0).abs() < 1e-12);
        assert_eq!(hits[1].score, 0.0);
    }

    #[test]
    fn semantic_ranker_retains_only_requested_hits() {
        let mut ranker = SemanticRanker::new(&[1.0, 0.0], 3).unwrap();
        for id in 0..10_000 {
            ranker.push(row(id, &[1.0, 0.0], "2026-10-01"));
            assert!(ranker.best.len() <= 3);
        }
        let hits = ranker.finish();
        assert_eq!(
            hits.iter()
                .map(|hit| hit.segment_id.as_str())
                .collect::<Vec<_>>(),
            vec!["9999", "9998", "9997"]
        );
        assert!(SemanticRanker::new(&[], 3).is_err());
        assert!(SemanticRanker::new(&[f32::NAN], 3).is_err());
        assert!(SemanticRanker::new(&vec![1.0; MAX_EMBEDDING_DIMENSIONS + 1], 3).is_err());
        assert!(SemanticRanker::new(&[1.0], 1_001).is_err());
    }

    fn shared_fixture() -> (
        std::sync::Arc<tokio::sync::Mutex<crate::db::Database>>,
        std::path::PathBuf,
    ) {
        let root = std::env::temp_dir().join(format!(
            "plainsong-semantic-shared-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("qa.db");
        let database = crate::db::Database::open_at_path(&path, None).unwrap();
        let mut writer = rusqlite::Connection::open(&path).unwrap();
        let tx = writer.transaction().unwrap();
        tx.execute("INSERT INTO recordings (id,title,project_id,created_at,updated_at,source_type,status,audio_path)
            VALUES ('meeting','Public design review','inbox','2026-10-01','2026-10-01','meeting','completed','')", []).unwrap();
        let blob: Vec<u8> = [1.0_f32, 0.0]
            .iter()
            .flat_map(|value| value.to_le_bytes())
            .collect();
        for id in 0..600 {
            tx.execute("INSERT INTO transcript_embeddings (recording_id,segment_id,text,embedding,model,start_time,end_time,created_at)
                VALUES ('meeting',?1,'Public evidence',?2,'m',0,1,'2026-10-01')",
                rusqlite::params![id.to_string(), blob]).unwrap();
        }
        tx.commit().unwrap();
        drop(writer);
        (std::sync::Arc::new(tokio::sync::Mutex::new(database)), root)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_shared_scan_allows_a_real_note_write_while_scoring() {
        let (database, root) = shared_fixture();
        let mut scan = Box::pin(search_embeddings_shared(
            &database,
            &[1.0, 0.0],
            5,
            "m",
            None,
            Some("meeting"),
        ));
        assert!(
            poll_once(scan.as_mut()).await.is_pending(),
            "Search must yield before its whole scan completes"
        );
        let mut writer = database
            .try_lock()
            .expect("Scoring must release the shared database");
        writer
            .update_recording_notes("meeting", Some("Public notes saved during recall"))
            .unwrap();
        drop(writer);
        let hits = scan.await.unwrap();
        assert_eq!(hits.len(), 5);
        assert_eq!(hits[0].segment_id, "599");
        drop(database);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_shared_scan_retries_after_relevant_change_without_mixed_hits() {
        let (database, root) = shared_fixture();
        let mut scan = Box::pin(search_embeddings_shared(
            &database,
            &[1.0, 0.0],
            5,
            "m",
            None,
            Some("meeting"),
        ));
        assert!(poll_once(scan.as_mut()).await.is_pending());
        database
            .try_lock()
            .unwrap()
            .rename_recording("meeting", "Updated public review")
            .unwrap();
        let hits = scan.await.unwrap();
        assert_eq!(hits.len(), 5);
        assert!(hits
            .iter()
            .all(|hit| hit.recording_title == "Updated public review"));
        drop(database);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_shared_scan_repeated_changes_return_an_error_instead_of_partial_hits() {
        let (database, root) = shared_fixture();
        let mut scan = Box::pin(search_embeddings_shared(
            &database,
            &[1.0, 0.0],
            5,
            "m",
            None,
            Some("meeting"),
        ));
        let mut result = None;
        for index in 0..100 {
            if let Poll::Ready(value) = poll_once(scan.as_mut()).await {
                result = Some(value);
                break;
            }
            database
                .try_lock()
                .unwrap()
                .rename_recording("meeting", &format!("Changed public review {index}"))
                .unwrap();
        }
        assert!(result
            .expect("Two interrupted attempts must settle")
            .unwrap_err()
            .to_string()
            .contains("generation changed"));
        drop(scan);
        drop(database);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_shared_scan_cancellation_releases_its_work() {
        let (database, root) = shared_fixture();
        let mut scan = Box::pin(search_embeddings_shared(
            &database,
            &[1.0, 0.0],
            5,
            "m",
            None,
            Some("meeting"),
        ));
        assert!(poll_once(scan.as_mut()).await.is_pending());
        assert!(database.try_lock().is_ok());
        drop(scan);
        assert!(database.try_lock().is_ok());
        drop(database);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn semantic_shared_scan_deadline_bounds_waiting_for_database() {
        let (database, root) = shared_fixture();
        let held = database.lock().await;
        let scope = EmbeddingSearchScope {
            model: "m".into(),
            dimensions: 2,
            exclude_recording_id: None,
            source_type: None,
        };
        let error = scan_once(
            &database,
            &scope,
            SemanticRanker::new(&[1.0, 0.0], 5).unwrap(),
            Instant::now() + Duration::from_millis(10),
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("waiting for the database"));
        drop(held);
        drop(database);
        std::fs::remove_dir_all(root).unwrap();
    }
}
