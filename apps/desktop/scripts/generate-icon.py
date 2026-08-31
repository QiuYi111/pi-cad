from pathlib import Path

from PIL import Image, ImageDraw


root = Path(__file__).resolve().parents[1] / "build"
root.mkdir(parents=True, exist_ok=True)
scale = 4
size = 256 * scale
image = Image.new("RGBA", (size, size), (8, 10, 12, 255))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((12 * scale, 12 * scale, 244 * scale, 244 * scale), radius=54 * scale, fill=(15, 18, 22, 255), outline=(53, 59, 67, 255), width=3 * scale)
stroke = 22 * scale
silver = (226, 230, 235, 255)
blue = (51, 124, 255, 255)
draw.line([(62 * scale, 76 * scale), (104 * scale, 128 * scale), (62 * scale, 180 * scale)], fill=silver, width=stroke, joint="curve")
draw.line([(194 * scale, 76 * scale), (152 * scale, 128 * scale), (194 * scale, 180 * scale)], fill=silver, width=stroke, joint="curve")
draw.line([(104 * scale, 128 * scale), (152 * scale, 128 * scale)], fill=blue, width=stroke, joint="curve")
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
