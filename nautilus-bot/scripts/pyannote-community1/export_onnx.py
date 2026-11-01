"""Export pyannote community-1's two networks to ONNX for Plainsong's Rust port.

usage: PYANNOTE_METRICS_ENABLED=false HF_HUB_OFFLINE=1 sandbox-exec -f nonet.sb \
         <pyannote.audio 4.0 venv>/bin/python -I export_onnx.py <community-1 dir> <out dir>

Source: pyannote-community/speaker-diarization-community-1 at revision
8a527374977391da736e0daaef26855d949d9685 (CC BY 4.0). Measured with pyannote.audio 4.0.7,
torch 2.14.1, onnx 1.23.2: the export is byte-deterministic (sha256 recorded in constants.json).

Writes
  segmentation.onnx  waveform (B,1,160000) f32 -> log_probs (B,589,7) f32
                     (PyanNet / segmentation-3.0 style powerset model, unchanged)
  embedding.onnx     fbank (B,998,80) f32 [kaldi fbank * 32768-scaled audio, mean-centred],
                     weights (B,S,125) f32 [per-speaker frame weights, already
                     nearest-interpolated from the 589 segmentation frames]
                     -> embeddings (B,S,256) f32
                     (WeSpeaker ResNet34 trunk + weighted statistics pooling + seg_1,
                     i.e. resnet.forward minus the fbank front end, with the pooling
                     evaluated for S speakers on one shared trunk pass)
  constants.json     receptive field, powerset mapping, min_num_samples, interpolation table
Telemetry is disabled; run under sandbox-exec nonet.sb.
"""
import os, sys, json, hashlib
os.environ["PYANNOTE_METRICS_ENABLED"] = "false"
os.environ["HF_HUB_OFFLINE"] = "1"
# onnx (and onnxruntime for the self-check) may live outside the pyannote venv
sys.path.extend(p for p in os.environ.get("PLAINSONG_EXPORT_PYDEPS", "").split(":") if p)
import numpy as np, torch, torch.nn as nn, torch.nn.functional as F
from pyannote.audio import Model
from pyannote.audio.telemetry import set_telemetry_metrics
from pyannote.audio.models.blocks.pooling import StatsPool
from pyannote.audio.utils.powerset import Powerset

set_telemetry_metrics(False)
src, out = sys.argv[1:3]
os.makedirs(out, exist_ok=True)
torch.manual_seed(0)

seg = Model.from_pretrained(os.path.join(src, "segmentation")).eval()
emb = Model.from_pretrained(os.path.join(src, "embedding")).eval()


class Seg(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.m = m

    def forward(self, waveform):
        return self.m(waveform)


class Emb(nn.Module):
    def __init__(self, m):
        super().__init__()
        self.r = m.resnet
        self.pool = StatsPool()

    def forward(self, fbank, weights):
        r = self.r
        x = fbank.permute(0, 2, 1).unsqueeze(1)
        x = F.relu(r.bn1(r.conv1(x)))
        x = r.layer4(r.layer3(r.layer2(r.layer1(x))))
        b, d, c, t = x.shape
        x = x.reshape(b, d * c, t)
        return r.seg_1(self.pool(x, weights=weights))


def sha(p):
    return hashlib.sha256(open(p, "rb").read()).hexdigest()


with torch.inference_mode():
    wav = torch.randn(2, 1, 160000) * 0.1
    ref_seg = seg(wav)
    torch.onnx.export(Seg(seg), (wav,), f"{out}/segmentation.onnx", dynamo=False, opset_version=17,
                      input_names=["waveform"], output_names=["log_probs"],
                      dynamic_axes={"waveform": {0: "batch"}, "log_probs": {0: "batch"}})

    fb = emb.compute_fbank(wav)
    assert fb.shape == (2, 998, 80), fb.shape
    w = (torch.rand(2, 3, 125) > 0.5).float()
    w[1, 2] = 0.0
    ref_emb = Emb(emb)(fb, w)
    torch.onnx.export(Emb(emb), (fb, w), f"{out}/embedding.onnx", dynamo=False, opset_version=17,
                      input_names=["fbank", "weights"], output_names=["embeddings"],
                      dynamic_axes={"fbank": {0: "batch"}, "weights": {0: "batch", 1: "speakers"},
                                    "embeddings": {0: "batch", 1: "speakers"}})

    # The wrapper must equal what the pipeline computes: resnet(fbank, weights=(B,589) mask)
    mask589 = (torch.rand(1, 589) > 0.3).float()
    direct = emb(wav[:1], weights=mask589)
    idx = torch.floor(torch.arange(125, dtype=torch.float32) * torch.tensor(589 / 125, dtype=torch.float32)).long().clamp(max=588)
    via = Emb(emb)(fb[:1], mask589[:, None, idx])[:, 0]
    interp = F.interpolate(mask589[:, None], size=125, mode="nearest")[:, 0]
    assert torch.equal(interp, mask589[:, idx]), "interpolation table differs from F.interpolate"
    print("wrapper vs pipeline embedding max abs diff", (direct - via).abs().max().item())

# check with onnxruntime (python) when available
try:
    import onnxruntime as ort
    s = ort.InferenceSession(f"{out}/segmentation.onnx", providers=["CPUExecutionProvider"])
    o = s.run(None, {"waveform": wav.numpy()})[0]
    print("seg ORT max abs diff", np.abs(o - ref_seg.numpy()).max(), "argmax agree", (o.argmax(-1) == ref_seg.numpy().argmax(-1)).mean())
    s = ort.InferenceSession(f"{out}/embedding.onnx", providers=["CPUExecutionProvider"])
    o = s.run(None, {"fbank": fb.numpy(), "weights": w.numpy()})[0]
    r = ref_emb.numpy()
    cos = (o * r).sum(-1) / np.linalg.norm(o, axis=-1) / np.linalg.norm(r, axis=-1)
    print("emb ORT max abs diff", np.abs(o - r).max(), "min cos", cos.min(), "ort", ort.__version__)
except ImportError as e:
    print("no onnxruntime:", e)

pset = Powerset(3, 2)
rf = seg.receptive_field
constants = {
    "segmentation": {"sample_rate": 16000, "chunk_samples": 160000, "step_samples": 16000, "num_frames": 589,
                     "frame_step_seconds": rf.step, "frame_duration_seconds": rf.duration,
                     "powerset_mapping": pset.mapping.int().tolist()},
    "embedding": {"num_fbank_frames": 998, "num_mel_bins": 80, "num_pool_frames": 125,
                  "min_num_samples": None, "interp_index": idx.tolist(), "dimension": 256},
    "sha256": {f: sha(f"{out}/{f}") for f in ["segmentation.onnx", "embedding.onnx"]},
    "source": {k: sha(os.path.join(src, k)) for k in ["segmentation/pytorch_model.bin", "embedding/pytorch_model.bin",
                                                         "plda/plda.npz", "plda/xvec_transform.npz", "config.yaml"]},
    "torch": torch.__version__,
}
from pyannote.audio.pipelines.speaker_verification import PyannoteAudioPretrainedSpeakerEmbedding
pe = PyannoteAudioPretrainedSpeakerEmbedding(os.path.join(src, "embedding"))
constants["embedding"]["min_num_samples"] = int(pe.min_num_samples)
json.dump(constants, open(f"{out}/constants.json", "w"), indent=1)
print(json.dumps({k: v for k, v in constants.items() if k != "embedding"}, indent=1))
print("min_num_samples", constants["embedding"]["min_num_samples"])
