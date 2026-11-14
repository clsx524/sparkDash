const quote = (value) => "'" + String(value).replace(/'/g, "'\\''") + "'";

/**
 * A Linux attached command owns its own process group and a stdin lease. Closing
 * SSH alone is insufficient: sshd can leave a launcher/rsync alive. The lease
 * kills only this attached group, never a service that has already detached.
 * Like llmlaunch's guard, start ticks protect against PID reuse.
 */
export function attachedCommand(command) {
  return `bash -c ${quote(`
pstart() { sed 's/.*) //' "/proc/$1/stat" 2>/dev/null | cut -d' ' -f20; }
P=; PST=
own_group() {
  [ -n "$P" ] || return 1
  if [ -d "/proc/$P" ]; then
    [ -n "$PST" ] && [ "$(pstart "$P")" = "$PST" ] || return 1
  fi
  kill -0 -- "-$P" 2>/dev/null
}
cancel() {
  trap '' HUP INT TERM
  if own_group; then
    kill -TERM -- "-$P" 2>/dev/null
    sleep 1
    own_group && kill -KILL -- "-$P" 2>/dev/null
  fi
  [ -z "$P" ] || wait "$P" 2>/dev/null
  exit 130
}
trap cancel HUP INT TERM
# No initial lease means cancellation happened before the remote launch.
IFS= read -r -t 4 LEASE || exit 130
setsid bash -c ${quote(command)} < /dev/null &
P=$!; PST=$(pstart "$P")
while kill -0 "$P" 2>/dev/null; do
  IFS= read -r -t 4 LEASE || cancel
done
wait "$P"
`)}`;
}
