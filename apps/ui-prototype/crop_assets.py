from pathlib import Path
from PIL import Image

assets = Path(__file__).parent / "public" / "assets"
assets.mkdir(parents=True, exist_ok=True)
source = Path("/mnt/c/Users/Admin/Downloads/reify_designs/final_prototype")

cad = Image.open(source / "ChatGPT Image 2026年9月5日 23_14_18 (3).png")
cad.crop((270, 145, 870, 700)).save(assets / "cad.png", optimize=True)

simulation = Image.open(source / "ChatGPT Image 2026年9月5日 23_14_20 (6).png")
simulation.crop((390, 205, 875, 735)).save(assets / "sim.png", optimize=True)
