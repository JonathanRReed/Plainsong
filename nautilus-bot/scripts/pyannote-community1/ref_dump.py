"""Run pyannote community-1 (pyannote.audio 4.0, PyTorch, CPU) over one recording and
dump every stage for the Rust parity checks.

usage: venv/bin/python -I ref_dump.py <pipeline dir> <wav> <out prefix> [cpu|mps] [embedding batch]
Writes <prefix>.npz (stages) and <prefix>.json (turns in pyannote_run.py's format).
Telemetry off; run under sandbox-exec nonet.sb."""
import os, sys, time, json, resource
os.environ["PYANNOTE_METRICS_ENABLED"] = "false"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["HF_HUB_DISABLE_TELEMETRY"] = "1"
pipe_dir, wav, prefix = sys.argv[1:4]
device = sys.argv[4] if len(sys.argv) > 4 else "cpu"
emb_batch = int(sys.argv[5]) if len(sys.argv) > 5 else 32
import numpy as np, soundfile as sf, torch
from pyannote.audio import Pipeline
from pyannote.audio.telemetry import set_telemetry_metrics
import pyannote.audio.pipelines.clustering as clmod

set_telemetry_metrics(False)
stages = {}
times = {}

orig_linkage, orig_fcluster, orig_vbx = clmod.linkage, clmod.fcluster, clmod.cluster_vbx


def linkage(x, **kw):
    z = orig_linkage(x, **kw)
    stages["linkage"] = z
    return z


def fcluster(z, t, **kw):
    out = orig_fcluster(z, t, **kw)
    stages["fcluster"] = out
    return out


def cluster_vbx(ahc, fea, phi, **kw):
    stages["ahc_clusters"] = ahc
    stages["plda_fea"] = fea
    stages["plda_phi"] = phi
    q, sp = orig_vbx(ahc, fea, phi, **kw)
    stages["vbx_q"], stages["vbx_sp"] = q, sp
    return q, sp


clmod.linkage, clmod.fcluster, clmod.cluster_vbx = linkage, fcluster, cluster_vbx
orig_call = clmod.VBxClustering.__call__


def vbx_call(self, embeddings, segmentations=None, **kw):
    _, ci, si = self.filter_embeddings(embeddings, segmentations=segmentations)
    stages["train_chunk_idx"], stages["train_speaker_idx"] = ci, si
    hard, soft, centroids = orig_call(self, embeddings, segmentations=segmentations, **kw)
    stages["hard_clusters_raw"] = hard.copy()
    stages["soft_clusters"] = soft
    stages["centroids"] = centroids
    times["clustering"] = time.time()
    return hard, soft, centroids


clmod.VBxClustering.__call__ = vbx_call

pipeline = Pipeline.from_pretrained(pipe_dir)
pipeline.to(torch.device(device))
pipeline.embedding_batch_size = emb_batch
raw = []
pipeline._segmentation.model.register_forward_hook(lambda m, i, o: raw.append(o.detach().cpu().numpy()))


def hook(name, artefact, file=None, completed=None, total=None, **kw):
    if completed is not None:
        return
    times[name] = time.time()
    if name == "segmentation":
        stages["binarized"] = artefact.data.astype(np.uint8)
    elif name == "speaker_counting":
        stages["count"] = artefact.data[:, 0].astype(np.uint8)
    elif name == "embeddings" and isinstance(artefact, np.ndarray) and artefact.ndim == 3:
        stages["embeddings"] = artefact.astype(np.float32)
    elif name == "discrete_diarization":
        stages["discrete"] = artefact.data.astype(np.uint8)


audio, sr = sf.read(wav, dtype="float32", always_2d=True)
audio = audio.mean(axis=1)
assert sr == 16000, sr
t0 = time.time()
output = pipeline({"waveform": torch.from_numpy(audio)[None], "sample_rate": sr}, hook=hook)
run_s = time.time() - t0
stages["raw_log_probs"] = np.concatenate(raw).astype(np.float32)
np.savez_compressed(prefix + ".npz", **stages)


def turns(ann):
    return [{"start": round(s.start, 3), "end": round(s.end, 3), "speaker": str(spk)} for s, _, spk in ann.itertracks(yield_label=True)]


stage_times, last = {}, t0
for k, v in sorted(times.items(), key=lambda kv: kv[1]):
    stage_times[k] = round(v - last, 2)
    last = v
res = {"audio": wav, "device": device, "embeddingBatch": emb_batch, "duration": len(audio) / sr, "runS": run_s, "rtfx": len(audio) / sr / run_s,
       "stageS": stage_times, "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss, "torchThreads": torch.get_num_threads(),
       "turns": turns(output.speaker_diarization), "exclusiveTurns": turns(output.exclusive_speaker_diarization)}
json.dump(res, open(prefix + ".json", "w"), indent=1)
print(f"{wav}: {len(output.speaker_diarization.labels())} speakers, run {run_s:.1f}s ({res['rtfx']:.0f}x RT) stages {stage_times} peak {res['peakRssBytes']/2**20:.0f} MB", file=sys.stderr)
