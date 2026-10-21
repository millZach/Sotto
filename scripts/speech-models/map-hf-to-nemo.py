"""Maps a Hugging Face Parakeet TDT checkpoint onto NVIDIA's v3 NeMo model and saves a .nemo.

How Sotto made its Parakeet Ultra (ADR-0094, docs/verification/2026-10-20-sotto-speech-models.md):
Moondream publishes Ultra only as Hugging Face weights. Run this with nemo_toolkit[asr] installed,
then sherpa-onnx's scripts/nemo/parakeet-tdt-0.6b-v3/export_onnx.py in the folder holding the
output, saved as parakeet-tdt-0.6b-v3.nemo, which is the name that script loads.

Usage: python -I map-hf-to-nemo.py <v3.nemo> <nvidia-v3-hf.safetensors> <ultra.safetensors> <out.nemo>

The key mapping is transformers' convert_nemo_to_hf.py (NEMO_TO_HF_WEIGHT_MAPPING plus
NEMO_TDT_WEIGHT_MAPPING), applied forward to every NeMo key. It is proved first on NVIDIA's own
HF export of v3, which must reproduce every tensor of the .nemo exactly.
"""
import re
import sys

import torch
from safetensors.torch import load_file
import nemo.collections.asr as nemo_asr

MAPPING = {
    r"encoder\.pre_encode\.conv\.": r"encoder.subsampling.layers.",
    r"encoder\.pre_encode\.out\.": r"encoder.subsampling.linear.",
    r"encoder\.pos_enc\.": r"encoder.encode_positions.",
    r"encoder\.layers\.(\d+)\.conv\.batch_norm\.": r"encoder.layers.\1.conv.norm.",
    r"decoder\.decoder_layers\.0\.(weight|bias)": r"ctc_head.\1",
    r"linear_([kv])": r"\1_proj",
    r"linear_out": r"o_proj",
    r"linear_q": r"q_proj",
    r"pos_bias_([uv])": r"bias_\1",
    r"linear_pos": r"relative_k_proj",
    r"decoder\.prediction\.embed\.": r"decoder.embedding.",
    r"decoder\.prediction\.dec_rnn\.lstm\.": r"decoder.lstm.",
    r"joint\.enc\.": r"encoder_projector.",
    r"joint\.pred\.": r"decoder.decoder_projector.",
    r"joint\.joint_net\.2\.": r"joint.head.",
}


def convert_key(key):
    for pattern, replacement in MAPPING.items():
        key = re.sub(pattern, replacement, key)
    return key


def mapped(nemo_state, hf_state):
    out, used = {}, set()
    for key, value in nemo_state.items():
        if key.endswith("featurizer.window") or key.endswith("featurizer.fb"):
            out[key] = value
            continue
        hf_key = convert_key(key)
        if hf_key not in hf_state:
            raise KeyError(f"{key} -> {hf_key} not in checkpoint")
        tensor = hf_state[hf_key]
        if tuple(tensor.shape) != tuple(value.shape):
            raise ValueError(f"{key}: shape {tuple(tensor.shape)} != {tuple(value.shape)}")
        used.add(hf_key)
        out[key] = tensor.to(value.dtype)
    return out, sorted(set(hf_state) - used)


def main():
    v3_nemo, v3_hf, ultra_hf, out_path = sys.argv[1:5]
    model = nemo_asr.models.ASRModel.restore_from(restore_path=v3_nemo, map_location="cpu")
    model.eval()
    state = {k: v.detach().clone() for k, v in model.state_dict().items()}
    print("nemo tensors", len(state))

    nvidia = load_file(v3_hf)
    out, extra = mapped(state, nvidia)
    exact = sum(1 for k in state if torch.equal(out[k], state[k]))
    print(f"control: nvidia hf -> nemo: {exact}/{len(state)} tensors bit-exact; unused hf keys: {extra}")
    if exact != len(state):
        raise SystemExit("mapping does not reproduce NVIDIA's own model")
    del nvidia, out

    ultra = load_file(ultra_hf)
    dtypes = sorted({str(t.dtype) for t in ultra.values()})
    print("ultra tensors", len(ultra), "dtypes", dtypes)
    out, extra = mapped(state, ultra)
    print("ultra keys not in NeMo's architecture (dropped):", extra)
    changed = [k for k in state if not torch.equal(out[k], state[k])]
    print(f"ultra differs from v3 in {len(changed)}/{len(state)} tensors")
    model.load_state_dict(out, strict=True)
    model.save_to(out_path)
    print("saved", out_path)


if __name__ == "__main__":
    main()
