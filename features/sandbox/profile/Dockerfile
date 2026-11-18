# Sandbox image for generated code (gap #6, T139).
#
# Minimal on purpose: python:3.12-slim + a non-root user + nothing
# else. No curl, no wget, no git, no docker client, no network tools,
# no compiler. A job that needs a tool installs it inside its own
# workspace or it does not run — the image does not hand the sandbox
# an exfiltration toolkit. The agent's code runs as uid 10001, the
# workspace is mounted at /workspace (read-write), the rootfs is
# read-only at run time (see docker-compose.sandbox.yml), and the only
# network route out is the egress proxy on the isolated bridge.
#
# Build on the machine (parent's job, needs the machine back):
#   docker build -t qwenpaw-sandbox:2.3.0 -f features/sandbox/profile/Dockerfile features/sandbox/profile/
#
# The tag 2.3.0 tracks the QwenPaw image it sandboxes. Bump both
# together; a sandbox image that does not match the agent image is a
# deployment smell, not a feature.
FROM python:3.12-slim

# No package manager use at run time, no cache left behind.
RUN groupadd -r sandbox -g 10001 \
 && useradd -r -u 10001 -g sandbox -d /workspace -s /usr/sbin/nologin sandbox \
 && rm -rf /var/lib/apt/lists/* \
 && mkdir -p /workspace /run/sandbox-token \
 && chown sandbox:sandbox /workspace /run/sandbox-token \
 && chmod 0700 /run/sandbox-token

# The sandbox runs one job and exits. It does not serve HTTP, does
# not listen on any port, and does not run a supervisor.
USER 10001:10001
WORKDIR /workspace

# The job entrypoint is supplied by the runner at `docker run` time
# (python3 /workspace/<job-script>). There is no default command that
# does work on its own: an image that runs without a job is a mistake.
CMD ["python3", "--version"]
