#!/bin/sh
# Started as root, this only hands the data folder to the cryptex user (a bind-mounted ./data starts out owned by
# root or by whoever created it), then drops root for good: the server and every command run as cryptex (10001).
# Started as another user (docker run --user), it changes nothing and runs the command as that user.
set -eu

if [ "$(id -u)" = 0 ]; then
  # Only what isn't cryptex's already (a new folder, files restored from a backup); -h never follows a symlink.
  if ! find "$DATA_DIR" \( \! -user cryptex -o \! -group cryptex \) -exec chown -h cryptex:cryptex {} + \
     || ! chmod 700 "$DATA_DIR"; then
    echo "Cryptex can't take ownership of $DATA_DIR. Make it writable by UID 10001: chown -R 10001:10001 on the host." >&2
    exit 1
  fi
  exec su-exec cryptex "$@"
fi
exec "$@"
