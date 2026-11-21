#!/usr/bin/env python3
"""Measure the disk work left for a SparkDash deployment without staging it."""
from collections import Counter
from pathlib import Path
import json
import os
import platform
import stat
import subprocess
import sys

from model_images import catalog, inspect, locally_verified, read_manifest


def inventory(request):
    registry = Path(request['root']).expanduser()
    specs = catalog() if request['images'] else {}
    images = {identity: read_manifest(registry, specs[identity])[0] for identity in request['images']}
    models = {}
    for folder in request['folders']:
        source = registry / folder
        # Match the staging walk: regular files, dereferenced symlinks, and no Hub metadata.
        raw = subprocess.check_output(['find', '-L', '.', '-name', '.cache', '-prune', '-o',
                                       '-type', 'f', '-printf', r'%s\t%Ts\t%P\0'], cwd=source)
        files = []
        for record in raw.split(b'\0'):
            if record:
                size, mtime, relative = record.split(b'\t', 2)
                files.append(dict(path=os.fsdecode(relative), size=int(size), mtime=int(mtime)))
        if not files:
            raise ValueError(f'No model files in {source}')
        models[folder] = files
    return dict(images=images, models=models)


def filesystem(path):
    while not path.exists() and path != path.parent:
        path = path.parent
    info = path.stat()
    usage = os.statvfs(path)
    return info.st_dev, usage.f_bavail * usage.f_frsize


def reclaimable(paths, device):
    # An inode is freed only when every hard link lies in the selected trees.
    links = set()
    sizes = {}
    for root in {Path(p).expanduser() for p in paths}:
        if root.is_symlink() or not root.is_dir():
            continue
        for dirname, dirs, files in os.walk(root):
            if os.stat(dirname).st_dev != device:
                dirs.clear()
                continue
            for name in files:
                item = (Path(dirname) / name).lstat()
                if stat.S_ISREG(item.st_mode) and item.st_dev == device:
                    links.add((item.st_ino, Path(dirname) / name))
                    sizes[item.st_ino] = (item.st_nlink, item.st_blocks * 512)
    counts = Counter(inode for inode, _ in links)
    return sum(size for inode, (nlink, size) in sizes.items() if counts[inode] == nlink)


def measure(request):
    root = Path(request['root']).expanduser()
    volumes = {}

    def volume(path, kind):
        device, free = filesystem(path)
        v = volumes.setdefault(device, dict(paths={}, freeBytes=free, evictableBytes=0))
        v['paths'][kind] = str(path)
        return device, v

    model_device, model = volume(root, 'models')
    for file in request['files']:
        destination = root / file['path']
        try:
            existing = destination.lstat()
        except FileNotFoundError:
            existing = None
        if (existing is None or not stat.S_ISREG(existing.st_mode) or existing.st_size != file['size']
                or int(existing.st_mtime) != file['mtime']):
            # rsync writes a full temporary replacement before removing the old file.
            model['weightBytes'] = model.get('weightBytes', 0) + file['size']
    model['evictableBytes'] = reclaimable(request['evict'], model_device)

    if request['images']:
        specs = catalog()
        missing = 0
        for identity, manifest in request['images'].items():
            spec = specs[identity]
            if not locally_verified(spec, manifest, inspect(spec['image'])):
                missing += manifest['bytes']
        if missing:
            docker_root = subprocess.check_output(['docker', 'info', '--format', '{{.DockerRootDir}}'], text=True).strip()
            _, docker = volume(Path(docker_root), 'images')
            docker['imageBytes'] = missing

    if request['runtimeBytes']:
        _, runtime = volume(Path.home(), 'runtime')
        runtime['runtimeBytes'] = request['runtimeBytes']
    memory = {key: int(value.split()[0]) / 1024**2 for key, _, value in
              (line.partition(':') for line in Path('/proc/meminfo').read_text().splitlines())
              if key in ('MemTotal', 'MemAvailable')}
    return dict(totalGiB=memory['MemTotal'], availableGiB=memory['MemAvailable'],
                machine=platform.machine(), volumes=list(volumes.values()))


if __name__ == '__main__':
    action, request = sys.argv[1:]
    print(json.dumps({'inventory': inventory, 'measure': measure}[action](json.loads(request))))
