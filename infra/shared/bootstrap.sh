#!/bin/bash
# Both implementations substitute these markers before passing this to EC2.
set -euo pipefail
umask 077

# The standard Amazon Linux 2023 image includes AWS CLI and SSM Agent.
systemctl enable --now amazon-ssm-agent
systemctl disable --now sshd.service
systemctl mask sshd.service
id honeyprinter >/dev/null 2>&1 || useradd --system --user-group --shell /sbin/nologin honeyprinter

artifact=$(mktemp)
trap 'rm -f "$artifact"' EXIT
# Allow for instance-role propagation and the initial network setup.
for attempt in {1..12}; do
  if aws s3 cp 's3://@ARTIFACT_BUCKET@/@ARTIFACT_KEY@' "$artifact" \
    --region us-west-2 --only-show-errors; then
    break
  fi
  sleep 5
done
printf '%s  %s\n' '@ARTIFACT_SHA256@' "$artifact" | sha256sum --check
install -m 0755 "$artifact" /usr/local/bin/honeyprinter

# Mock delivery for the comparison: minute summaries go to journald.
cat > /etc/systemd/system/honeyprinter.service <<'UNIT'
[Unit]
Description=Honeyprinter protocol decoys
After=network-online.target
Wants=network-online.target

[Service]
User=honeyprinter
Group=honeyprinter
ExecStart=/usr/local/bin/honeyprinter --bind 0.0.0.0 --port-offset 0
Restart=on-failure
RestartSec=5
UMask=0077
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
TimeoutStopSec=90
LimitNOFILE=4096

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now honeyprinter
