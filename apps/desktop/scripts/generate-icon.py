from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter


root = Path(__file__).resolve().parents[1] / "build"
root.mkdir(parents=True, exist_ok=True)
scale = 4
size = 256 * scale
image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((10 * scale, 10 * scale, 246 * scale, 246 * scale), radius=54 * scale, fill=(31, 39, 34, 255), outline=(91, 111, 99, 150), width=2 * scale)

def icon_points(points):
    return [((x * 3 + 32) * scale, (y * 3 + 32) * scale) for x, y in points]

def cubic(start, control_a, control_b, end, steps=36):
    result = []
    for index in range(1, steps + 1):
        t = index / steps
        u = 1 - t
        result.append((
            u**3 * start[0] + 3 * u * u * t * control_a[0] + 3 * u * t * t * control_b[0] + t**3 * end[0],
            u**3 * start[1] + 3 * u * u * t * control_a[1] + 3 * u * t * t * control_b[1] + t**3 * end[1],
        ))
    return result

# Smooth vector fit of the measured silhouette from the approved brand sheet.
top_trace = [(6.3, 4)]
top_trace += cubic((6.3, 4), (5.6, 4.7), (5.1, 6.3), (5.5, 7.3))
top_trace += [(42.8, 37.3)]
top_trace += cubic((42.8, 37.3), (45.5, 38.4), (48.2, 38), (50.3, 37.3))
top_trace += cubic((50.3, 37.3), (56.3, 34.8), (60, 29.5), (60, 23.8))
top_trace += [(60, 18.1)]
top_trace += cubic((60, 18.1), (60, 10.3), (53.7, 4), (45.7, 4))
bottom_trace = [(17.4, 27.3)]
bottom_trace += cubic((17.4, 27.3), (15.8, 27.3), (14.3, 28), (13.2, 29))
bottom_trace += [(8.6, 33.5)]
bottom_trace += cubic((8.6, 33.5), (5.6, 36.4), (4, 40.3), (4, 44.6))
bottom_trace += [(4, 48.5)]
bottom_trace += cubic((4, 48.5), (4, 54.9), (9.4, 60), (16, 60))
bottom_trace += [(59.2, 60)]
bottom_trace += cubic((59.2, 60), (59.7, 59.2), (59.7, 58.2), (59.2, 57.3))
bottom_trace += [(23.4, 28)]
bottom_trace += cubic((23.4, 28), (21.5, 27.3), (19.4, 27.1), (17.4, 27.3))
top = icon_points(top_trace)
bottom = icon_points(bottom_trace)

shadow = Image.new("RGBA", image.size, (0, 0, 0, 0))
shadow_draw = ImageDraw.Draw(shadow)
shadow_draw.polygon([(x, y + 5 * scale) for x, y in top + bottom], fill=(0, 0, 0, 125))
shadow = shadow.filter(ImageFilter.GaussianBlur(7 * scale))
image.alpha_composite(shadow)

top_mask = Image.new("L", image.size, 0)
ImageDraw.Draw(top_mask).polygon(top, fill=255)
bottom_mask = Image.new("L", image.size, 0)
ImageDraw.Draw(bottom_mask).polygon(bottom, fill=255)

top_fill = Image.new("RGBA", image.size)
bottom_fill = Image.new("RGBA", image.size)
top_px = top_fill.load()
bottom_px = bottom_fill.load()
for y in range(size):
    light = y / size
    for x in range(size):
        top_px[x, y] = (int(244 - 62 * light), int(239 - 61 * light), int(232 - 58 * light), 255)
        bottom_px[x, y] = (int(104 - 51 * light), int(119 - 58 * light), int(108 - 54 * light), 255)
image.paste(top_fill, (0, 0), top_mask)
image.paste(bottom_fill, (0, 0), bottom_mask)
image = image.resize((256, 256), Image.Resampling.LANCZOS)
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
