"""Compare Plainsong's community-1 port with the PyTorch reference, stage by stage.

usage: <pyannote venv>/bin/python -I compare_stages.py <ref prefix> <rust dump dir> [<rust raw.json>] [--json out.json]
<ref prefix>.npz/.json come from ref_dump.py; the dump dir and raw JSON from
`community1-eval --dump`. Prints one line per stage; with --json writes them."""
import json, os, sys
import numpy as np
from scipy.optimize import linear_sum_assignment

args = [a for a in sys.argv[1:] if not a.startswith("--")]
out_json = sys.argv[sys.argv.index("--json") + 1] if "--json" in sys.argv else None
if out_json in args:
    args.remove(out_json)
ref_prefix, dump = args[0], args[1]
raw_json = args[2] if len(args) > 2 else None
ref = np.load(ref_prefix + ".npz")
rs = lambda name: np.load(os.path.join(dump, name + ".npy"))
report = {}


def line(stage, **values):
    report[stage] = values
    print(f"{stage:>14}: " + ", ".join(f"{k}={v}" for k, v in values.items()))


# 1. segmentation network output
r_lp, p_lp = rs("raw_log_probs"), ref["raw_log_probs"]
line("log_probs", shape_equal=r_lp.shape == p_lp.shape, max_abs=float(np.abs(r_lp - p_lp).max()),
     mean_abs=float(np.abs(r_lp - p_lp).mean()), argmax_agree=float((r_lp.argmax(-1) == p_lp.argmax(-1)).mean()))
# 2. powerset decoding
r_b, p_b = rs("binarized"), ref["binarized"]
line("binarized", frames_equal=float((r_b == p_b).all(-1).mean()), chunks_identical=float((r_b == p_b).all((1, 2)).mean()))
# 3. count
r_c, p_c = rs("count"), ref["count"]
line("count", shape=f"{r_c.shape}/{p_c.shape}", agree=float((r_c == p_c).mean()) if r_c.shape == p_c.shape else None)
# 4. embeddings, where both sides saw the same masks and the speaker is active
r_e, p_e = rs("embeddings"), ref["embeddings"].astype(np.float32)
same = (r_b == p_b).all(1)  # chunks x speakers with identical masks
active = p_b.sum(1) > 0
sel = same & active
cos = (r_e[sel] * p_e[sel]).sum(-1) / np.linalg.norm(r_e[sel], axis=-1) / np.linalg.norm(p_e[sel], axis=-1)
line("embeddings", compared=int(sel.sum()), min_cos=float(cos.min()), mean_cos=float(cos.mean()),
     p001_cos=float(np.quantile(cos, 0.001)), max_abs=float(np.abs(r_e[sel] - p_e[sel]).max()))
# 5. training set
r_t = rs("train")
p_t = np.stack([ref["train_chunk_idx"], ref["train_speaker_idx"]], 1)
line("train_set", rust=len(r_t), ref=len(p_t), identical=bool(r_t.shape == p_t.shape and (r_t == p_t).all()))


def agreement(a, b):
    """Fraction of items with the same label under the best one-to-one label mapping."""
    a, b = np.asarray(a), np.asarray(b)
    la, lb = np.unique(a), np.unique(b)
    m = np.zeros((len(la), len(lb)))
    for i, x in enumerate(la):
        for j, y in enumerate(lb):
            m[i, j] = np.sum((a == x) & (b == y))
    r, c = linear_sum_assignment(-m)
    return float(m[r, c].sum() / len(a)), len(la), len(lb)


# 6. AHC
if r_t.shape == p_t.shape and (r_t == p_t).all():
    r_a, p_a = rs("ahc_clusters"), ref["ahc_clusters"]
    agree, nr, np_ = agreement(r_a, p_a)
    line("ahc", identical_labels=bool((r_a == p_a).all()), agree=agree, clusters=f"{nr}/{np_}")
    # 7. VBx
    if os.path.exists(os.path.join(dump, "vbx_q.npy")):
        r_q, p_q = rs("vbx_q"), ref["vbx_q"]
        if r_q.shape == p_q.shape:
            line("vbx", q_max_abs=float(np.abs(r_q - p_q).max()), sp_max_abs=float(np.abs(rs("vbx_sp") - ref["vbx_sp"]).max()),
                 kept=f"{int((rs('vbx_sp') > 1e-7).sum())}/{int((ref['vbx_sp'] > 1e-7).sum())}")
        else:
            line("vbx", shape=f"{r_q.shape}/{p_q.shape}")
# 8. centroids
r_k, p_k = rs("centroids"), ref["centroids"]
if r_k.shape == p_k.shape and len(r_k):
    cc = (r_k @ p_k.T) / np.linalg.norm(r_k, axis=1)[:, None] / np.linalg.norm(p_k, axis=1)[None]
    rr, ccol = linear_sum_assignment(-cc)
    line("centroids", count=f"{len(r_k)}/{len(p_k)}", min_matched_cos=float(cc[rr, ccol].min()))
else:
    line("centroids", count=f"{len(r_k)}/{len(p_k)}")
# 9. hard clusters of active local speakers
p_h = ref["hard_clusters_raw"].astype(int).copy()
p_h[ref["binarized"].sum(1) == 0] = -2
r_h = rs("hard_clusters")
mask = (p_h >= 0) | (r_h >= 0)
agree, nr, np_ = agreement(r_h[mask], p_h[mask])
line("hard_clusters", agree=agree, assigned=f"{int((r_h >= 0).sum())}/{int((p_h >= 0).sum())}")
# 10. discrete diarization (regular)
r_d, p_d = rs("discrete"), ref["discrete"]
if r_d.shape[0] == p_d.shape[0]:
    m = r_d.T.astype(float) @ p_d.astype(float)
    rr, ccol = linear_sum_assignment(-m)
    mapped = np.zeros_like(p_d)
    for i, j in zip(rr, ccol):
        mapped[:, j] = r_d[:, i]
    line("discrete", frames=r_d.shape[0], cols=f"{r_d.shape[1]}/{p_d.shape[1]}", frame_agree=float((mapped == p_d).all(1).mean()))
else:
    line("discrete", frames=f"{r_d.shape[0]}/{p_d.shape[0]}")
# 11. final turns: DER of the port against the reference output (no collar)
if raw_json:
    from pyannote.core import Annotation, Segment
    from pyannote.metrics.diarization import DiarizationErrorRate
    rj, pj = json.load(open(raw_json)), json.load(open(ref_prefix + ".json"))
    for key in ["turns", "exclusiveTurns"]:
        a, b = Annotation(), Annotation()
        for i, t in enumerate(pj[key]):
            a[Segment(t["start"], t["end"]), i] = t["speaker"]
        for i, t in enumerate(rj[key]):
            b[Segment(t["start"], t["end"]), i] = t["speaker"]
        der = DiarizationErrorRate(collar=0.0, skip_overlap=False)(a, b)
        line(f"{key}_vs_ref", der_pct=round(100 * der, 3), speakers=f"{len(b.labels())}/{len(a.labels())}")
if out_json:
    json.dump(report, open(out_json, "w"), indent=1)
