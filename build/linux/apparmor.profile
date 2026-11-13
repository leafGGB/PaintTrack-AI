abi <abi/4.0>,
include <tunables/global>

profile painttrack /opt/painttrack/PaintTrack flags=(unconfined) {
  userns,
  include if exists <local/painttrack>
}
