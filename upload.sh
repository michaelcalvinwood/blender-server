#!/bin/bash
rsync -a --exclude ".git" --exclude="node_modules" . root@node.pymnts.com:/home/blender/
