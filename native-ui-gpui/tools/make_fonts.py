"""Turn the app's own WOFF2 fonts into static TTF instances GPUI can load.

Figtree and Spline Sans Mono ship in the Electron app as variable WOFF2 files.
GPUI loads TrueType bytes, and picks a weight by face, so this writes one
static instance per weight the prototype uses. Run once:

    python tools/make_fonts.py

Needs fontTools and brotli. Both fonts are SIL Open Font Licence 1.1.
"""

import pathlib
import sys

from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

HERE = pathlib.Path(__file__).resolve().parent.parent
REPO = HERE.parent
OUT = HERE / "assets" / "fonts"

SOURCES = {
    "Figtree": (REPO / "src/shared/fonts/figtree-latin.woff2", [400, 500, 600, 700]),
    "SplineSansMono": (REPO / "src/renderer/src/assets/fonts/spline-sans-mono-latin.woff2", [400, 500]),
}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for name, (path, weights) in SOURCES.items():
        for weight in weights:
            font = TTFont(path)
            if "fvar" in font:
                axes = {axis.axisTag: axis for axis in font["fvar"].axes}
                limits = {}
                if "wght" in axes:
                    limits["wght"] = weight
                font = instancer.instantiateVariableFont(font, limits, updateFontNames=True)
            font.flavor = None
            target = OUT / f"{name}-{weight}.ttf"
            font.save(target)
            print(f"wrote {target.relative_to(HERE)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
