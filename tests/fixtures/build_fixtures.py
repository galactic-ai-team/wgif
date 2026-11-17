"""Generate deterministic, tiny WGIF interoperability fixtures (stdlib only)."""
from __future__ import annotations
import hashlib, io, json, struct, warnings, zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
DOS_DATE = (2000, 1, 1, 0, 0, 0)

def jsonbytes(obj):
    return (json.dumps(obj, sort_keys=True, separators=(',', ':'), ensure_ascii=False) + '\n').encode()

def glb():
    text = json.dumps({'asset': {'version': '2.0'}, 'scene': 0, 'scenes': [{'nodes': []}], 'nodes': []}, separators=(',', ':')).encode()
    text += b' ' * ((-len(text)) % 4)
    return b'glTF' + struct.pack('<II', 2, 20 + len(text)) + struct.pack('<I4s', len(text), b'JSON') + text

# Valid minimal 1x1 RGB PNG.
PNG = bytes.fromhex('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c49444154789c63606060000000040001f61738550000000049454e44ae426082')

def base_world(mode='editable', layer=False):
    files = {'world.glb': glb(), 'preview.png': PNG,
             'interactions.json': jsonbytes({'version': '0.1', 'camera': {'spawn': [0, 1.7, 3]}}),
             'game-state.json': jsonbytes({'version': '0.1', 'score': 0})}
    if layer: files['layers/friend.json'] = jsonbytes({'version': '0.1', 'add': []})
    manifest = {'wgif': '0.1', 'id': 'test.fixture.world', 'title': 'WGIF Fixture',
                'creator': {'name': 'WGIF Interop Corpus'}, 'created': '2026-11-15T00:00:00Z',
                'mode': mode, 'entry': {'scene': 'world.glb', 'preview': 'preview.png',
                 'interactions': 'interactions.json', 'state': 'game-state.json'},
                'requires': ['scene.glb'], 'files': []}
    if layer: manifest['layers'] = [{'id': 'friend', 'path': 'layers/friend.json', 'author': 'Fixture'}]
    return manifest, files

def populate(m, files):
    roles = {'world.glb': 'scene', 'preview.png': 'preview', 'interactions.json': 'interactions', 'game-state.json': 'state'}
    m['files'] = [{'path': p, 'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data), 'role': roles.get(p, 'layer' if p.startswith('layers/') else 'asset')}
                  for p, data in sorted(files.items())]
    return m

def archive(m, files, *, first='manifest.json', compression=zipfile.ZIP_STORED, dup=False):
    out = io.BytesIO()
    order = [(first, jsonbytes(m) if first == 'manifest.json' else files[first])]
    if first != 'manifest.json': order += [('manifest.json', jsonbytes(m))]
    order += [(p, files[p]) for p in sorted(files) if p != first]
    with zipfile.ZipFile(out, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for path, data in order:
            zi = zipfile.ZipInfo(path, DOS_DATE)
            zi.compress_type = compression if path == 'manifest.json' else zipfile.ZIP_DEFLATED
            z.writestr(zi, data)
        if dup:
            with warnings.catch_warnings():
                warnings.simplefilter('ignore', UserWarning)
                z.writestr(zipfile.ZipInfo('manifest.json', DOS_DATE), jsonbytes(m))
    return out.getvalue()

def write(name, data):
    (HERE / name).write_bytes(data)
    print(name, len(data))

m, f = base_world()
populate(m, f)
write('good-minimal.wgif', archive(m, f))
m2, f2 = base_world('layered', True)
populate(m2, f2)
write('good-layered.wgif', archive(m2, f2))
write('bad-notzip.wgif', b'not a zip')
write('bad-truncated.wgif', archive(m, f)[:-11])
write('bad-duplicate.wgif', archive(m, f, dup=True))
write('bad-missing-manifest.wgif', archive(m, f, first='world.glb'))
write('bad-compressed-manifest.wgif', archive(m, f, compression=zipfile.ZIP_DEFLATED))
f3 = dict(f, **{'../escape.txt': b'nope'})
populate(m3 := dict(m), f3)
write('bad-traversal.wgif', archive(m3, f3))
fp = dict(f, **{'assets/__proto__/x.txt': b'unsafe object property'})
populate(mp := dict(m), fp)
write('bad-prototype.wgif', archive(mp, fp))
f4 = dict(f, **{'game-state.json': b'{"version":"0.1","score":999}'})
write('bad-hash.wgif', archive(m, f4))
f5 = dict(f, **{'game-state.json': b'not json'})
populate(m5 := dict(m), f5)
write('bad-json.wgif', archive(m5, f5))
f6 = dict(f, **{'interactions.json': jsonbytes({'version': '0.1', 'camera': {'spawn': [0, 1]}})})
populate(m6 := dict(m), f6)
write('bad-interactions.wgif', archive(m6, f6))
fstate = dict(f, **{'game-state.json': jsonbytes({'version': '0.1', 'objects': {'ball': {'position': [1]}}})})
populate(ms := dict(m), fstate)
write('bad-state.wgif', archive(ms, fstate))
flayer = dict(f2, **{'layers/friend.json': jsonbytes({'version': '0.1', 'add': [{'id': 'bad', 'primitive': 'script', 'position': [0, 0, 0]}]})})
populate(ml := dict(m2), flayer)
write('bad-layer.wgif', archive(ml, flayer))
f7 = dict(f, **{'extra.js': b'WGIF rejects this filename, regardless of content'})
populate(m7 := dict(m), f7)
write('bad-executable.wgif', archive(m7, f7))
m8 = dict(m, wgif='1.0')
write('bad-major.wgif', archive(m8, f))
(HERE / 'expected.json').write_text(json.dumps({'pass': ['good-minimal.wgif', 'good-layered.wgif'],
    'reject': ['bad-notzip.wgif', 'bad-truncated.wgif', 'bad-duplicate.wgif', 'bad-missing-manifest.wgif',
               'bad-compressed-manifest.wgif', 'bad-traversal.wgif', 'bad-prototype.wgif', 'bad-hash.wgif', 'bad-json.wgif',
               'bad-interactions.wgif', 'bad-state.wgif', 'bad-layer.wgif', 'bad-executable.wgif', 'bad-major.wgif']}, indent=2) + '\n')
