#!/usr/bin/env python3
"""Fetches and downsizes the third-party images the sample worlds embed. Run once by a human;
the results are committed under assets/ so `npm run build` stays offline and reproducible.

  python3 examples/worlds/scripts/prepare-assets.py   (needs network + Pillow)

Sources (all free to reuse, see assets/CREDITS.md):
  - Wikimedia Commons public-domain paintings (resolved through the Commons API, which also
    returns the licence string; the script refuses anything not marked "Public domain").
  - Poly Haven "Rooftop Night" by Greg Zaal, CC0, tonemapped equirectangular JPG.
"""
import io, json, pathlib, sys, time, urllib.parse, urllib.request
from PIL import Image

OUT = pathlib.Path(__file__).resolve().parent.parent / 'assets'
UA = {'User-Agent': 'wgif-sample-builder/0.1 (https://github.com/galactic-ai-team/wgif)'}
ART = [
    ('art-great-wave', 'Tsunami by hokusai 19th century.jpg'),
    ('art-starry-night', 'Van Gogh - Starry Night - Google Art Project.jpg'),
    ('art-pearl-earring', '1665 Girl with a Pearl Earring.jpg'),
    ('art-impression-sunrise', 'Claude Monet, Impression, soleil levant.jpg'),
    ('art-birth-of-venus', 'Sandro Botticelli - La nascita di Venere - Google Art Project - edited.jpg'),
    ('art-the-kiss', 'The Kiss - Gustav Klimt - Google Cultural Institute.jpg'),
]
SKY = ('sky-rooftop-night', 'https://dl.polyhaven.org/file/ph-assets/HDRIs/extra/Tonemapped%20JPG/rooftop_night.jpg')


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120).read()


def save_jpg(img, name, size, quality):
    img = img.convert('RGB')
    img.thumbnail(size, Image.LANCZOS)
    buf = io.BytesIO()
    img.save(buf, 'JPEG', quality=quality, optimize=True, progressive=False)
    (OUT / f'{name}.jpg').write_bytes(buf.getvalue())
    return img.size, len(buf.getvalue())


def main():
    OUT.mkdir(exist_ok=True)
    credits = []
    for name, title in ART:
        q = urllib.parse.urlencode({'action': 'query', 'titles': f'File:{title}', 'prop': 'imageinfo',
                                    'iiprop': 'url|extmetadata', 'iiurlwidth': '960', 'format': 'json'})
        page = next(iter(json.loads(get(f'https://commons.wikimedia.org/w/api.php?{q}'))['query']['pages'].values()))
        info = page['imageinfo'][0]
        lic = info['extmetadata'].get('LicenseShortName', {}).get('value')
        if lic != 'Public domain':
            sys.exit(f'{title}: licence is {lic!r}, not public domain; refusing')
        size, n = save_jpg(Image.open(io.BytesIO(get(info['thumburl']))), name, (512, 512), 80)
        credits.append({'file': f'{name}.jpg', 'source': info['descriptionurl'], 'license': lic, 'size': size, 'bytes': n})
        time.sleep(1)
    size, n = save_jpg(Image.open(io.BytesIO(get(SKY[1]))), SKY[0], (2048, 1024), 72)
    credits.append({'file': f'{SKY[0]}.jpg', 'source': 'https://polyhaven.com/a/rooftop_night', 'license': 'CC0', 'size': size, 'bytes': n})
    print(json.dumps(credits, indent=1))


if __name__ == '__main__':
    main()
