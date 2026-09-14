#!/usr/bin/env python3
"""Bake NeuroMechFly v2 meshes (Apache-2.0, EPFL) into a compact game GLB.

The Sketchfab listing the user named is not downloadable (standard Sketchfab
license, Alicia Hidalgo Lab / Birmingham). NeuroMechFly is the open CT-scan
body from the Ramdya lab at EPFL and is the Swiss research mesh this project
can actually ship.

Source assets: https://github.com/NeLy-EPFL/fly-svg-maker (vendored flygym).
"""

from __future__ import annotations

import json
import math
import struct
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = Path("/tmp/nmf-assets/src/assets")
OUT = ROOT / "public" / "models"
NOTICE_IN = SRC / "NOTICE"

DEG2RAD = math.pi / 180


def quat_to_m3(q: list[float]) -> list[float]:
    w, x, y, z = q
    n = math.hypot(w, x, y, z) or 1
    w, x, y, z = w / n, x / n, y / n, z / n
    return [
        1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
        2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
        2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y),
    ]


def axis_angle(axis: list[float], angle: float) -> list[float]:
    ax, ay, az = axis
    c, s, t = math.cos(angle), math.sin(angle), 1 - math.cos(angle)
    return [
        c + t * ax * ax, t * ax * ay - s * az, t * ax * az + s * ay,
        t * ax * ay + s * az, c + t * ay * ay, t * ay * az - s * ax,
        t * ax * az - s * ay, t * ay * az + s * ax, c + t * az * az,
    ]


def m3mul(a: list[float], b: list[float]) -> list[float]:
    c = [0.0] * 9
    for i in range(3):
        for j in range(3):
            c[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j]
    return c


def hom(r: list[float], p: list[float]) -> list[float]:
    return [r[0], r[1], r[2], p[0], r[3], r[4], r[5], p[1], r[6], r[7], r[8], p[2], 0, 0, 0, 1]


def m4mul(a: list[float], b: list[float]) -> list[float]:
    c = [0.0] * 16
    for i in range(4):
        for j in range(4):
            c[i * 4 + j] = a[i * 4] * b[j] + a[i * 4 + 1] * b[4 + j] + a[i * 4 + 2] * b[8 + j] + a[i * 4 + 3] * b[12 + j]
    return c


def apply(m: list[float], v: tuple[float, float, float]) -> tuple[float, float, float]:
    x, y, z = v
    return (
        m[0] * x + m[1] * y + m[2] * z + m[3],
        m[4] * x + m[5] * y + m[6] * z + m[7],
        m[8] * x + m[9] * y + m[10] * z + m[11],
    )


def read_stl(path: Path) -> list[tuple[float, float, float]]:
    data = path.read_bytes()
    n = struct.unpack_from("<I", data, 80)[0]
    verts: list[tuple[float, float, float]] = []
    o = 84
    for _ in range(n):
        o += 12
        for _v in range(3):
            x, y, z = struct.unpack_from("<fff", data, o)
            verts.append((x, y, z))
            o += 12
        o += 2
    return verts


def joint_dofs(model: dict) -> dict[str, list[dict]]:
    mapping: dict[str, list[dict]] = {}
    for dof in model["dofs"]:
        axis = dof["axis"] if isinstance(dof["axis"], list) else model["axisVector"][dof["axis"]]
        mapping.setdefault(f"{dof['parent']}>{dof['child']}", []).append({"name": dof["name"], "axis": axis})
    return mapping


def segment_transforms(model: dict, angles: dict[str, float]) -> dict[str, list[float]]:
    dof_map = joint_dofs(model)
    root = model["rest"][model["root"]]
    t = {model["root"]: hom(quat_to_m3(root["quat"]), root["pos"])}
    for parent, child in model["joints"]:
        cfg = model["rest"][child]
        rest = hom(quat_to_m3(cfg["quat"]), cfg["pos"])
        rot = [1, 0, 0, 0, 1, 0, 0, 0, 1]
        for item in dof_map.get(f"{parent}>{child}", []):
            angle = angles.get(item["name"], 0.0)
            if angle:
                rot = m3mul(rot, axis_angle(item["axis"], angle))
        t[child] = m4mul(m4mul(t[parent], rest), hom(rot, [0, 0, 0]))
    return t


def group_of(name: str) -> str:
    if name in {"l_wing"}:
        return "lWing"
    if name in {"r_wing"}:
        return "rWing"
    if name == "c_thorax":
        return "thorax"
    if name.endswith("_eye") or name in {"l_eye", "r_eye"}:
        return "eyes"
    if name.split("_")[0] in {"lf", "lm", "lh", "rf", "rm", "rh"}:
        return "legs"
    return "body"


def pad4(blob: bytes) -> bytes:
    return blob + b"\x00" * ((4 - len(blob) % 4) % 4)


def write_glb(path: Path, meshes: dict[str, list[float]], extras: dict, pivots: dict[str, list[float]]) -> None:
    views = []
    accessors = []
    gl_meshes = []
    nodes = []
    cursor = 0
    bin_parts: list[bytes] = []
    names = ["thorax", "body", "eyes", "lWing", "rWing", "legs"]
    for name in names:
        pos = meshes[name]
        if not pos:
            raise SystemExit(f"empty mesh {name}")
        normals: list[float] = []
        for i in range(0, len(pos), 9):
            ax, ay, az = pos[i:i + 3]
            bx, by, bz = pos[i + 3:i + 6]
            cx, cy, cz = pos[i + 6:i + 9]
            ux, uy, uz = bx - ax, by - ay, bz - az
            vx, vy, vz = cx - ax, cy - ay, cz - az
            nx, ny, nz = uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx
            length = math.hypot(nx, ny, nz) or 1
            nx, ny, nz = nx / length, ny / length, nz / length
            normals.extend([nx, ny, nz, nx, ny, nz, nx, ny, nz])
        pos_b = struct.pack("<" + "f" * len(pos), *pos)
        nrm_b = struct.pack("<" + "f" * len(normals), *normals)
        count = len(pos) // 3
        xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
        views.append({"buffer": 0, "byteOffset": cursor, "byteLength": len(pos_b), "target": 34962})
        accessors.append({
            "bufferView": len(views) - 1, "componentType": 5126, "count": count, "type": "VEC3",
            "min": [min(xs), min(ys), min(zs)], "max": [max(xs), max(ys), max(zs)],
        })
        cursor += len(pos_b)
        views.append({"buffer": 0, "byteOffset": cursor, "byteLength": len(nrm_b), "target": 34962})
        accessors.append({"bufferView": len(views) - 1, "componentType": 5126, "count": count, "type": "VEC3"})
        cursor += len(nrm_b)
        bin_parts.extend([pos_b, nrm_b])
        pi, ni = len(accessors) - 2, len(accessors) - 1
        gl_meshes.append({"name": name, "primitives": [{"attributes": {"POSITION": pi, "NORMAL": ni}, "material": len(gl_meshes)}]})
        node: dict = {"name": name, "mesh": len(gl_meshes) - 1}
        if name in pivots:
            node["translation"] = pivots[name]
        nodes.append(node)

    materials = [
        {"name": "thorax", "pbrMetallicRoughness": {"baseColorFactor": [0.73, 0.45, 0.29, 1], "metallicFactor": 0.08, "roughnessFactor": 0.62}},
        {"name": "body", "pbrMetallicRoughness": {"baseColorFactor": [0.72, 0.56, 0.29, 1], "metallicFactor": 0.05, "roughnessFactor": 0.7}},
        {"name": "eyes", "pbrMetallicRoughness": {"baseColorFactor": [0.78, 0.16, 0.22, 1], "metallicFactor": 0.12, "roughnessFactor": 0.28}},
        {"name": "wing", "pbrMetallicRoughness": {"baseColorFactor": [0.86, 0.93, 0.90, 0.42], "metallicFactor": 0.05, "roughnessFactor": 0.22},
         "alphaMode": "BLEND", "doubleSided": True},
        {"name": "wingR", "pbrMetallicRoughness": {"baseColorFactor": [0.86, 0.93, 0.90, 0.42], "metallicFactor": 0.05, "roughnessFactor": 0.22},
         "alphaMode": "BLEND", "doubleSided": True},
        {"name": "legs", "pbrMetallicRoughness": {"baseColorFactor": [0.28, 0.22, 0.16, 1], "metallicFactor": 0.04, "roughnessFactor": 0.78}},
    ]
    blob = b"".join(bin_parts)
    gltf = {
        "asset": {"version": "2.0", "generator": "housefly bake_drosophila.py"},
        "scene": 0,
        "scenes": [{"nodes": list(range(len(nodes))), "name": "drosophila", "extras": extras}],
        "nodes": nodes,
        "meshes": gl_meshes,
        "materials": materials,
        "buffers": [{"byteLength": len(blob)}],
        "bufferViews": views,
        "accessors": accessors,
    }
    raw_json = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    json_bytes = raw_json + b" " * ((4 - len(raw_json) % 4) % 4)
    blob = pad4(blob)
    total = 12 + 8 + len(json_bytes) + 8 + len(blob)
    header = struct.pack("<III", 0x46546C67, 2, total)
    json_chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    bin_chunk = struct.pack("<II", len(blob), 0x004E4942) + blob
    path.write_bytes(header + json_chunk + bin_chunk)


def main() -> None:
    model = json.loads((SRC / "model.json").read_text())
    angles = {dof["name"]: (model["neutralDeg"].get(dof["name"], 0.0) * DEG2RAD) for dof in model["dofs"]}
    transforms = segment_transforms(model, angles)
    cache: dict[str, list[tuple[float, float, float]]] = {}
    groups = {name: [] for name in ("thorax", "body", "eyes", "lWing", "rWing", "legs")}
    scale = float(model["meshScale"])
    for segment in model["segments"]:
        spec = model["meshes"][segment]
        path = SRC / "meshes" / spec["file"]
        if segment.endswith(("tarsus3", "tarsus4", "tarsus5")):
            continue
        if spec["file"] not in cache:
            cache[spec["file"]] = read_stl(path)
        local = []
        sign = -1 if spec["mirror"] else 1
        raw = cache[spec["file"]]
        for i in range(0, len(raw), 3):
            tri = [(p[0] * scale, p[1] * scale * sign, p[2] * scale) for p in raw[i:i + 3]]
            if spec["mirror"]:
                tri[1], tri[2] = tri[2], tri[1]
            local.extend(tri)
        world = [apply(transforms[segment], v) for v in local]
        # NMF: x forward, y left, z up  ->  game: x right, y up, z forward
        game = [(-y, z, x) for x, y, z in world]
        groups[group_of(segment)].extend(c for p in game for c in p)

    xs, ys, zs = [], [], []
    for pos in groups.values():
        xs += pos[0::3]; ys += pos[1::3]; zs += pos[2::3]
    min_y, max_y = min(ys), max(ys)
    height = max_y - min_y
    target = 1.18
    s = target / height
    cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
    for name, pos in groups.items():
        out = []
        for i in range(0, len(pos), 3):
            out.extend([(pos[i] - cx) * s, (pos[i + 1] - min_y) * s, (pos[i + 2] - cz) * s])
        groups[name] = out

    def game_point(nmf: tuple[float, float, float]) -> tuple[float, float, float]:
        x, y, z = nmf
        return ((-y - cx) * s, (z - min_y) * s, (x - cz) * s)

    def translation(matrix: list[float]) -> tuple[float, float, float]:
        return matrix[3], matrix[7], matrix[11]

    pivots = {
        "lWing": list(game_point(translation(transforms["l_wing"]))),
        "rWing": list(game_point(translation(transforms["r_wing"]))),
    }
    for name, pivot in pivots.items():
        pos = groups[name]
        out = []
        for i in range(0, len(pos), 3):
            out.extend([pos[i] - pivot[0], pos[i + 1] - pivot[1], pos[i + 2] - pivot[2]])
        groups[name] = out

    OUT.mkdir(parents=True, exist_ok=True)
    glb = OUT / "drosophila.glb"
    extras = {"source": "NeuroMechFly v2 / flygym Apache-2.0", "wingPivots": pivots}
    write_glb(glb, groups, extras, pivots)
    (OUT / "NOTICE").write_text((NOTICE_IN.read_text() if NOTICE_IN.exists() else "") + """
Housefly bakes these meshes into drosophila.glb for real-time rendering.
NeuroMechFly v2: Wang-Chen et al. (2024), Nature Methods.
https://doi.org/10.1038/s41592-024-02497-y
https://github.com/NeLy-EPFL/flygym
""")
    print(f"Wrote {glb} ({glb.stat().st_size} bytes)")
    for name, pos in groups.items():
        print(f"  {name}: {len(pos) // 9} triangles")


if __name__ == "__main__":
    main()
