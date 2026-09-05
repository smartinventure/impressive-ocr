<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# The Docker installer

`install-impressive-ocr.sh` sets up the headless server on a Linux host: it writes a compose
file, starts the container, and installs a host-side updater so the **Update now** button in
the app works.

This file is the canonical source. It is served directly from the public repository, so the
link in a registration email is:

```
https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh
```

## What to put in an email

```
Install with Docker (Linux):

  curl -fsSL https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh | bash

Or download and read it first, which is the right habit for any script piped into a shell:

  curl -fsSLO https://raw.githubusercontent.com/smartinventure/impressive-ocr/main/deploy/installer/install-impressive-ocr.sh
  less install-impressive-ocr.sh
  bash install-impressive-ocr.sh

It asks before doing anything, and prints where it put everything when it finishes.
```

## Why the update needs a host script at all

**A container cannot update itself.** Updating means pulling a new image and recreating the
container — and the process doing that has to outlive the container being replaced, so it has
to run on the host.

The usual shortcut is to mount `/var/run/docker.sock` into the application container so it can
drive Docker directly. That is root-equivalent access to the host: anything that can reach
that socket can start a privileged container with the host filesystem mounted. For a service
whose job is to open untrusted documents out of a watched folder, it is not a trade worth
making for a convenience button, so this product does not do it.

Instead the work is split, and the interface between the halves is two empty files in a small
bind-mounted directory:

```
  inside the container                        on the host
  --------------------                        -----------
  GET  /api/update/check                      impressive-ocr-update.sh, triggered by
    -> newer image? host updater listening?   a systemd path unit or a cron poll
  POST /api/update/trigger                           |
    -> writes control/update-request  ---------------+--> docker compose pull
                                                          docker compose up -d
                                                          docker image prune -f
                                                          rm control/update-request
```

| File | Written by | Read by | Meaning |
|---|---|---|---|
| `control/host-update-enabled` | the installer | the app | A host updater is watching, so show the button |
| `control/update-request` | the app | the host script | Please update |

**The host script never reads the request file's contents.** It acts on the file existing and
runs one hard-coded command. Nothing inside the container can influence what runs on the host,
which is the property that makes this safe where the Docker socket would not be.

If the marker is missing — a container someone started by hand, or a control directory the
container cannot write to — the app hides the button and shows the manual command instead. A
button that silently does nothing is worse than no button.

## The watcher

A **systemd path unit** when the script can use `sudo`: event-driven, so the update starts the
moment the button is pressed. Otherwise a **cron** entry polling once a minute, which needs no
root and works anywhere, at the cost of up to a minute's delay.

## Uninstalling

```sh
bash install-impressive-ocr.sh --uninstall
```

Removes the watcher, the updater script and the marker, and stops the container. It does not
touch your data: that lives in the `impressive-ocr-data` volume, and deleting it is a separate
`docker volume rm` the script prints rather than runs.

## Desktop is a different mechanism entirely

The Electron app uses `electron-updater`: it checks the release feed, downloads in the
background and offers a restart. None of this applies to it, and the app never asks the server
for an update when it is running inside the desktop shell.
