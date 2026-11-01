//! Centroid-linkage agglomerative clustering and the `distance` flat cut,
//! ported from scipy 1.18 (`cluster/hierarchy/_hierarchy.pyx`: `fast_linkage`,
//! the generic algorithm of Müllner 2011, plus `cluster_dist`), which is what
//! pyannote's `VBxClustering` calls as
//! `fcluster(linkage(x, "centroid", "euclidean"), threshold, "distance")`.
//!
//! One deliberate difference: scipy keeps the condensed `n(n-1)/2` distance
//! matrix and updates it with the Lance-Williams centroid formula, which for a
//! two-hour meeting is about a gigabyte. Centroid linkage is exactly the
//! Euclidean distance between cluster means, so this port keeps the means
//! (`n x 256` doubles) and computes each distance when it is needed. The merge
//! order, the heap, the neighbour bookkeeping and the tie rules are scipy's;
//! only the last bits of a merged cluster's distances can differ (the direct
//! distance is the more accurate of the two).

/// One row of scipy's linkage matrix: the two cluster ids (smaller first),
/// the merge distance and the merged size.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(super) struct Merge {
    pub left: usize,
    pub right: usize,
    pub distance: f64,
    pub size: usize,
}

struct Heap {
    index_by_key: Vec<usize>,
    key_by_index: Vec<usize>,
    values: Vec<f64>,
    size: usize,
}

impl Heap {
    fn new(values: Vec<f64>) -> Self {
        let size = values.len();
        let mut heap = Self {
            index_by_key: (0..size).collect(),
            key_by_index: (0..size).collect(),
            values,
            size,
        };
        for i in (0..size / 2).rev() {
            heap.sift_down(i);
        }
        heap
    }

    fn get_min(&self) -> (usize, f64) {
        (self.key_by_index[0], self.values[0])
    }

    fn remove_min(&mut self) {
        self.swap(0, self.size - 1);
        self.size -= 1;
        self.sift_down(0);
    }

    fn change_value(&mut self, key: usize, value: f64) {
        let index = self.index_by_key[key];
        let old = self.values[index];
        self.values[index] = value;
        if value < old {
            self.sift_up(index);
        } else {
            self.sift_down(index);
        }
    }

    fn sift_up(&mut self, mut index: usize) {
        while index > 0 {
            let parent = (index - 1) >> 1;
            if self.values[parent] > self.values[index] {
                self.swap(index, parent);
                index = parent;
            } else {
                break;
            }
        }
    }

    fn sift_down(&mut self, mut index: usize) {
        let mut child = (index << 1) + 1;
        while child < self.size {
            if child + 1 < self.size && self.values[child + 1] < self.values[child] {
                child += 1;
            }
            if self.values[index] > self.values[child] {
                self.swap(index, child);
                index = child;
                child = (index << 1) + 1;
            } else {
                break;
            }
        }
    }

    fn swap(&mut self, i: usize, j: usize) {
        self.values.swap(i, j);
        let key_i = self.key_by_index[i];
        let key_j = self.key_by_index[j];
        self.key_by_index[i] = key_j;
        self.key_by_index[j] = key_i;
        self.index_by_key[key_i] = j;
        self.index_by_key[key_j] = i;
    }
}

struct Centroids {
    dim: usize,
    means: Vec<f64>,
    size: Vec<usize>,
}

impl Centroids {
    /// Euclidean distance between the means in slots `a` and `b`, always
    /// evaluated in the same order so a repeated query returns the same bits.
    fn distance(&self, a: usize, b: usize) -> f64 {
        let (a, b) = if a < b { (a, b) } else { (b, a) };
        let x = &self.means[a * self.dim..(a + 1) * self.dim];
        let y = &self.means[b * self.dim..(b + 1) * self.dim];
        x.iter()
            .zip(y)
            .map(|(p, q)| (p - q) * (p - q))
            .sum::<f64>()
            .sqrt()
    }

    /// scipy's `find_min_dist`: the nearest live slot above `x` (first wins on ties).
    fn nearest_above(&self, x: usize) -> Option<(usize, f64)> {
        let mut best: Option<(usize, f64)> = None;
        for i in (x + 1)..self.size.len() {
            if self.size[i] == 0 {
                continue;
            }
            let d = self.distance(x, i);
            if best.is_none_or(|(_, current)| d < current) {
                best = Some((i, d));
            }
        }
        best
    }
}

/// scipy `linkage(points, method="centroid", metric="euclidean")`.
/// `points` is row-major `n x dim`.
pub(super) fn centroid_linkage(points: &[f64], dim: usize) -> Vec<Merge> {
    let n = if dim == 0 { 0 } else { points.len() / dim };
    if n < 2 {
        return Vec::new();
    }
    let mut c = Centroids {
        dim,
        means: points.to_vec(),
        size: vec![1; n],
    };
    let mut cluster_id: Vec<usize> = (0..n).collect();
    let mut neighbor = vec![0usize; n - 1];
    let mut min_dist = vec![0.0f64; n - 1];
    for x in 0..n - 1 {
        let (y, d) = c.nearest_above(x).expect("slot n-1 is live");
        neighbor[x] = y;
        min_dist[x] = d;
    }
    let mut heap = Heap::new(min_dist.clone());
    let mut merges = Vec::with_capacity(n - 1);

    for k in 0..n - 1 {
        let (mut x, mut dist) = heap.get_min();
        let mut y = neighbor[x];
        for _ in 0..(n - k) {
            let (key, value) = heap.get_min();
            x = key;
            dist = value;
            y = neighbor[x];
            if dist == c.distance(x, y) {
                break;
            }
            let (ny, nd) = c.nearest_above(x).expect("slot n-1 is live");
            y = ny;
            dist = nd;
            neighbor[x] = y;
            min_dist[x] = dist;
            heap.change_value(x, dist);
        }
        heap.remove_min();

        let (nx, ny) = (c.size[x], c.size[y]);
        let (id_x, id_y) = (cluster_id[x], cluster_id[y]);
        merges.push(Merge {
            left: id_x.min(id_y),
            right: id_x.max(id_y),
            distance: dist,
            size: nx + ny,
        });

        // The merged mean replaces slot y; slot x is dropped.
        let total = (nx + ny) as f64;
        for d in 0..dim {
            let mx = c.means[x * dim + d];
            let my = c.means[y * dim + d];
            c.means[y * dim + d] = (nx as f64 * mx + ny as f64 * my) / total;
        }
        c.size[x] = 0;
        c.size[y] = nx + ny;
        cluster_id[y] = n + k;

        for (z, candidate) in neighbor.iter_mut().enumerate().take(x) {
            if c.size[z] > 0 && *candidate == x {
                *candidate = y;
            }
        }
        for z in 0..y {
            if c.size[z] == 0 {
                continue;
            }
            let d = c.distance(z, y);
            if d < min_dist[z] {
                neighbor[z] = y;
                min_dist[z] = d;
                heap.change_value(z, d);
            }
        }
        if y < n - 1 {
            if let Some((z, d)) = c.nearest_above(y) {
                neighbor[y] = z;
                min_dist[y] = d;
                heap.change_value(y, d);
            }
        }
    }
    merges
}

/// scipy `fcluster(Z, cutoff, criterion="distance") - 1`: flat cluster labels
/// in scipy's numbering (depth-first from the root, left child first), so the
/// label order that VBx and the later tie-breaks see is the reference's.
pub(super) fn flat_clusters(merges: &[Merge], n: usize, cutoff: f64) -> Vec<usize> {
    if n == 0 {
        return Vec::new();
    }
    if n == 1 {
        return vec![0];
    }
    // get_max_dist_for_each_cluster
    let mut max_dist = vec![0.0f64; n - 1];
    let mut visited = vec![false; 2 * n - 1];
    let mut stack = vec![2 * n - 2];
    while let Some(&node) = stack.last() {
        let root = node - n;
        let Merge {
            left,
            right,
            distance,
            ..
        } = merges[root];
        if left >= n && !visited[left] {
            visited[left] = true;
            stack.push(left);
            continue;
        }
        if right >= n && !visited[right] {
            visited[right] = true;
            stack.push(right);
            continue;
        }
        let mut value = distance;
        if left >= n && max_dist[left - n] > value {
            value = max_dist[left - n];
        }
        if right >= n && max_dist[right - n] > value {
            value = max_dist[right - n];
        }
        max_dist[root] = value;
        stack.pop();
    }

    // cluster_monocrit
    let mut labels = vec![0usize; n];
    let mut visited = vec![false; 2 * n - 1];
    let mut stack = vec![2 * n - 2];
    let mut n_cluster = 0usize;
    let mut leader: Option<usize> = None;
    while let Some(&node) = stack.last() {
        let root = node - n;
        let Merge { left, right, .. } = merges[root];
        if leader.is_none() && max_dist[root] <= cutoff {
            leader = Some(root);
            n_cluster += 1;
        }
        if left >= n && !visited[left] {
            visited[left] = true;
            stack.push(left);
            continue;
        }
        if right >= n && !visited[right] {
            visited[right] = true;
            stack.push(right);
            continue;
        }
        if left < n {
            if leader.is_none() {
                n_cluster += 1;
            }
            labels[left] = n_cluster;
        }
        if right < n {
            if leader.is_none() {
                n_cluster += 1;
            }
            labels[right] = n_cluster;
        }
        if leader == Some(root) {
            leader = None;
        }
        stack.pop();
    }
    labels.into_iter().map(|label| label - 1).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merges_follow_centroid_distances() {
        // Two tight pairs far apart on a line: 0,1 at 0/1 and 2,3 at 10/12.
        let points = [0.0, 1.0, 10.0, 12.0];
        let merges = centroid_linkage(&points, 1);
        assert_eq!(merges.len(), 3);
        assert_eq!(
            (merges[0].left, merges[0].right, merges[0].distance),
            (0, 1, 1.0)
        );
        assert_eq!(
            (merges[1].left, merges[1].right, merges[1].distance),
            (2, 3, 2.0)
        );
        // centroids 0.5 and 11.0
        assert_eq!((merges[2].left, merges[2].right), (4, 5));
        assert!((merges[2].distance - 10.5).abs() < 1e-12);
        assert_eq!(merges[2].size, 4);
        assert_eq!(flat_clusters(&merges, 4, 3.0), vec![0, 0, 1, 1]);
        assert_eq!(flat_clusters(&merges, 4, 0.5), vec![0, 1, 2, 3]);
        assert_eq!(flat_clusters(&merges, 4, 11.0), vec![0, 0, 0, 0]);
    }

    #[test]
    fn an_inversion_is_cut_by_the_largest_distance_below_it() {
        // 0 and 1 merge at 2.0; their mean (1, 0) is 1.9 from point 2, so the
        // second merge is lower than the first (a centroid-linkage inversion).
        let points = [0.0, 0.0, 2.0, 0.0, 1.0, 1.9];
        let merges = centroid_linkage(&points, 2);
        assert_eq!(
            (merges[0].left, merges[0].right, merges[0].distance),
            (0, 1, 2.0)
        );
        assert_eq!((merges[1].left, merges[1].right), (2, 3));
        assert!((merges[1].distance - 1.9).abs() < 1e-12);
        // The root's subtree maximum is 2.0, so a 1.95 cut splits everything.
        assert_eq!(flat_clusters(&merges, 3, 1.95), vec![0, 1, 2]);
        assert_eq!(flat_clusters(&merges, 3, 2.0), vec![0, 0, 0]);
    }
}
