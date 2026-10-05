#!/usr/bin/env python3
"""Build and remount-verify the standard drag-install DMG from a signed app."""
import argparse
import hashlib
import os
from pathlib import Path
import plistlib
import subprocess
import tempfile
import time
from contextlib import contextmanager

from ds_store import DSStore
from mac_alias import Alias
from PIL import Image, ImageDraw


def run(*args):
    subprocess.run([str(arg) for arg in args], check=True, timeout=180)


@contextmanager
def mounted(image, mount, readonly=False):
    mount.mkdir()
    args = ["hdiutil", "attach", "-nobrowse", "-mountpoint", mount]
    if readonly:
        args.append("-readonly")
    try:
        run(*args, image)
        yield mount
    finally:
        # An attach timeout can still leave a mount behind.
        for attempt in range(5):
            if not os.path.ismount(mount):
                break
            result = subprocess.run(
                ["hdiutil", "detach", str(mount)], timeout=30, check=False
            )
            if result.returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError(f"Cannot detach {mount}; retained for manual recovery")


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def verify_layout(mount):
    with DSStore.open(str(mount / ".DS_Store"), "r") as ds:
        view = ds["."]["icvp"]
        alias = Alias.from_bytes(view["backgroundImageAlias"])
        # Regression guard: /var and /private/var must never create /../ aliases.
        if alias.target.posix_path != "/.background.tiff":
            raise RuntimeError(f"Non-portable background alias: {alias.target.posix_path}")
        if view["backgroundType"] != 2:
            raise RuntimeError("Image background is not enabled")
        if ds["Latte Work.app"]["Iloc"] != (170, 188) or ds["Applications"]["Iloc"] != (430, 188):
            raise RuntimeError("Installer icon positions changed")
        window = ds["."]["bwsp"]
        if any(window[key] for key in ("ShowToolbar", "ShowSidebar", "ShowStatusBar", "ShowPathbar")):
            raise RuntimeError("Installer chrome must be hidden")
    if os.readlink(mount / "Applications") != "/Applications":
        raise RuntimeError("Invalid Applications shortcut")
    with Image.open(mount / ".background.tiff") as image:
        if image.size != (1200, 800) or image.crop((570, 350, 640, 395)).getextrema()[0][0] >= 200:
            raise RuntimeError("Missing installation arrow")


def package(app, output_dir):
    app = app.resolve(strict=True)
    output_dir = output_dir.resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    with (app / "Contents/Info.plist").open("rb") as stream:
        info = plistlib.load(stream)
    version = info["CFBundleShortVersionString"]
    if not version or any(c not in "0123456789.-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" for c in version):
        raise ValueError("Invalid bundle version")
    binary = app / "Contents/MacOS" / info["CFBundleExecutable"]
    arches = set(subprocess.check_output(["lipo", "-archs", str(binary)], text=True, timeout=30).split())
    architecture = {frozenset({"arm64"}): "arm64", frozenset({"x86_64"}): "x64", frozenset({"arm64", "x86_64"}): "universal"}.get(frozenset(arches))
    if architecture is None:
        raise ValueError(f"Unsupported architectures: {arches}")
    run("codesign", "--verify", "--deep", "--strict", app)
    output = output_dir / f"Latte-Work-{version}-{architecture}.dmg"
    volume = f"Latte Work {version} {architecture}"
    # Resolve the temporary path before passing it to mac_alias (macOS /var symlink).
    temp = Path(tempfile.mkdtemp(prefix="latte-dmg-", dir=output_dir)).resolve()
    try:
        stage = temp / "stage"
        stage.mkdir()
        run("ditto", app, stage / "Latte Work.app")
        (stage / "Applications").symlink_to("/Applications")
        image = Image.new("RGB", (1200, 800), "white")
        draw = ImageDraw.Draw(image)
        for x, gray in [(575, 220), (594, 195), (613, 165)]:
            draw.line([(x, 360), (x + 11, 372), (x, 384)], fill=(gray,) * 3, width=6, joint="curve")
        image.save(stage / ".background.tiff", dpi=(144, 144), compression="tiff_lzw")
        size = sum(p.stat().st_size for p in stage.rglob("*") if p.is_file() and not p.is_symlink())
        megabytes = max(80, (size * 2) // (1024 * 1024) + 32)
        writable = temp / "layout.dmg"
        run("hdiutil", "create", "-volname", volume, "-size", f"{megabytes}m", "-fs", "HFS+", writable)
        with mounted(writable, temp / "layout") as mount:
            run("ditto", stage, mount)
            alias = Alias.for_file(str((mount / ".background.tiff").resolve()))
            with DSStore.open(str(mount / ".DS_Store"), "w+") as ds:
                ds["."]["bwsp"] = {"ContainerShowSidebar": False, "PreviewPaneVisibility": False, "ShowPathbar": False, "ShowSidebar": False, "ShowStatusBar": False, "ShowTabView": False, "ShowToolbar": False, "SidebarWidth": 180, "WindowBounds": "{{200, 180}, {600, 400}}"}
                ds["."]["icvl"] = ("type", b"icnv")
                ds["."]["icvp"] = {"arrangeBy": "none", "backgroundColorBlue": 1.0, "backgroundColorGreen": 1.0, "backgroundColorRed": 1.0, "backgroundImageAlias": alias.to_bytes(), "backgroundType": 2, "gridOffsetX": 0.0, "gridOffsetY": 0.0, "gridSpacing": 100.0, "iconSize": 100.0, "labelOnBottom": True, "scrollPositionX": 0.0, "scrollPositionY": 0.0, "showIconPreview": False, "showItemInfo": False, "textSize": 13.0, "viewOptionsVersion": 1}
                ds["."]["vSrn"] = ("long", 1)
                ds["Latte Work.app"]["Iloc"] = (170, 188)
                ds["Applications"]["Iloc"] = (430, 188)
            verify_layout(mount)
        candidate = temp / "installer.dmg"
        run("hdiutil", "convert", writable, "-format", "UDZO", "-o", candidate)
        run("hdiutil", "verify", candidate)
        with mounted(candidate, temp / "verify", readonly=True) as mount:
            verify_layout(mount)
            bundled = mount / "Latte Work.app"
            run("codesign", "--verify", "--deep", "--strict", bundled)
            for name in (info["CFBundleExecutable"], "latte-work-server"):
                if digest(app / "Contents/MacOS" / name) != digest(bundled / "Contents/MacOS" / name):
                    raise RuntimeError(f"Packaged binary mismatch: {name}")
        checksum = digest(candidate)
        # Replace the previous deliverable only after all verification succeeds.
        os.replace(candidate, output)
        checksum_file = temp / "checksum"
        checksum_file.write_text(f"{checksum}  {output.name}\n")
        os.replace(checksum_file, output.with_suffix(".dmg.sha256"))
    except BaseException:
        print(f"Packaging failed; diagnostic files retained at {temp}")
        raise
    else:
        import shutil
        shutil.rmtree(temp)  # Only this invocation's unmounted staging directory.
    print(output)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    package(args.app, args.output_dir)
