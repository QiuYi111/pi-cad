# syntax=docker/dockerfile:1
#
# Reify workspace image (implementation plan section 6).
# One image per pi-cad commit. Build with cloud/image/build.sh.
#
# Build args:
#   PRIME_AGENT_REF   required. Tag or commit of QiuYi111/prime-agent.
#                     Use the same Prime version as the desktop installer.
#   PRIME_AGENT_REPO  Prime Agent git URL.
#   NODE_VERSION      Node 22 release (the desktop bundles Node 22).
#   UV_VERSION        uv release, copied from the official uv image.
#   REIFY_REV         pi-cad commit, recorded as a label.
#
# Install locations (all owned by root, read-only for uid 1000):
#   /opt/reify/node             Node 22
#   /opt/reify/prime-agent      Prime Agent
#   /opt/reify/pi-cad           pi-cad, Python venv in python/.venv
#   /opt/reify/freecad          FreeCAD (scripts/bootstrap-freecad.sh)
#   /opt/reify/pi-cad/cloud/workspace-gateway   gateway (same tree as pi-cad)
#   /opt/reify/python           uv-managed Python interpreters
#   /opt/reify/defaults         seed files copied into the user home at start

ARG UV_VERSION=0.9.7
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv

FROM ubuntu:24.04

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

ARG TARGETARCH
ARG NODE_VERSION=22.20.0
ARG PRIME_AGENT_REPO=https://github.com/QiuYi111/prime-agent.git
ARG PRIME_AGENT_REF
ARG REIFY_REV=unknown

LABEL org.opencontainers.image.source="https://github.com/QiuYi111/pi-cad" \
      dev.reify.pi-cad-rev="${REIFY_REV}"

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    PATH=/opt/reify/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# 1. System packages.
#    bzip2 is needed by scripts/bootstrap-freecad.sh (micromamba archive).
#    xz-utils is needed to unpack the Node tarball.
#    libgl1 and libx11-6: the OCP kernel in python/.venv (build123d) links libGL.so.1 and libX11.so.6.
#    Ubuntu 24.04's libglu1-mesa depends on libopengl0 only and does not pull them in.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bubblewrap libglu1-mesa libgl1 libx11-6 ripgrep git ca-certificates curl tini bzip2 xz-utils \
 && rm -rf /var/lib/apt/lists/*

# 2. Non-root user. Ubuntu 24.04 ships a user with uid 1000; remove it first.
#    The home directory lives on the workspace volume.
RUN if id -u ubuntu >/dev/null 2>&1; then userdel -r ubuntu; fi \
 && groupadd --gid 1000 reify \
 && useradd --uid 1000 --gid 1000 --no-create-home --home-dir /workspace/home --shell /bin/bash reify \
 && mkdir -p /opt/reify /workspace

# 3. Node 22 into /opt/reify/node. Checksums come from the same release directory.
RUN set -eux; \
    case "${TARGETARCH:-amd64}" in \
      amd64) node_arch=x64 ;; \
      arm64) node_arch=arm64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="node-v${NODE_VERSION}-linux-${node_arch}"; \
    cd /tmp; \
    curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/${base}.tar.xz"; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" -o SHASUMS256.txt; \
    grep " ${base}.tar.xz\$" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /opt/reify/node; \
    tar -xJf "${base}.tar.xz" -C /opt/reify/node --strip-components=1; \
    rm -f "${base}.tar.xz" SHASUMS256.txt; \
    node --version

# 4. uv (copied from the official image, pinned by UV_VERSION).
COPY --from=uv /uv /uvx /usr/local/bin/

# 5. Prime Agent at a fixed ref. Same build steps as the README (npm ci).
RUN : "${PRIME_AGENT_REF:?PRIME_AGENT_REF build arg is required}" \
 && git clone --filter=blob:none "${PRIME_AGENT_REPO}" /opt/reify/prime-agent \
 && git -C /opt/reify/prime-agent checkout --detach "${PRIME_AGENT_REF}" \
 && cd /opt/reify/prime-agent \
 && npm ci \
 && (cd packages/tui && npm run build) \
 && { (cd packages/ai && npm run build) || echo "warning: prime-agent ai build reported type errors (TS2536 in generated models); dist was still emitted"; } \
 && { (cd packages/agent && npm run build) || echo "warning: prime-agent agent build reported type errors"; } \
 && cd packages/coding-agent \
 && { npx tsgo -p tsconfig.build.json || echo "warning: prime-agent coding-agent build reported type errors"; } \
 && npx shx chmod +x dist/cli.js && npm run copy-assets && npm run bundle \
 && cd /opt/reify/prime-agent \
 && rm -rf /opt/reify/prime-agent/.git /root/.npm

# 5b. reify-asi, the DFM geometry analyzer (native: Analysis Situs + OCCT 7.6 from conda-forge).
#     It only needs the bootstrap script and native/reify-asi, so it is built before the pi-cad tree is copied
#     and stays cached when other files change. PI_CAD_ASI_HOME selects /opt/reify/asi. The script never uses sudo.
#     The build tree, sources and download cache are not needed at run time; env/ (OCCT libraries) and bin/ are.
#     Modes are fixed in this same layer: the global chmod in step 9 would copy every file again on overlayfs.
COPY scripts/bootstrap-asi.sh /opt/reify/asi-build/scripts/bootstrap-asi.sh
COPY native/reify-asi /opt/reify/asi-build/native/reify-asi
RUN apt-get update \
 && apt-get install -y --no-install-recommends patch \
 && rm -rf /var/lib/apt/lists/* \
 && cd /opt/reify/asi-build \
 && PI_CAD_ASI_HOME=/opt/reify/asi bash scripts/bootstrap-asi.sh \
 && rm -rf /opt/reify/asi/build /opt/reify/asi/downloads /opt/reify/asi/mamba-root/pkgs /opt/reify/asi-build /root/.cache \
 && find /opt/reify/asi -xdev ! -type l \( -perm /022 -o ! -perm -444 -o \( -type d ! -perm -111 \) \) -exec chmod go-w,a+rX {} +

# 6. pi-cad. Dependencies first (cacheable), then the source tree.
#    --ignore-scripts here: postinstall runs once, in setup:python below.
ENV UV_PYTHON_INSTALL_DIR=/opt/reify/python \
    UV_CACHE_DIR=/workspace/home/.cache/uv \
    PYTHONDONTWRITEBYTECODE=1
# Prime uses Python 3.11. Bootstrap during the image build, while /opt is writable.
# Each workspace gets its own copy so updates and locks remain private to that user.
RUN uv python install 3.11 \
 && HOME=/tmp PRIME_AGENT_KERNEL_VENV=/opt/reify/kernel-template \
      node /opt/reify/prime-agent/packages/coding-agent/dist/core/kernel/bootstrap-cli.js \
 && find /opt/reify/kernel-template /opt/reify/python -xdev ! -type l \
      \( -perm /022 -o ! -perm -444 -o \( -type d ! -perm -111 \) \) -exec chmod go-w,a+rX {} + \
 && rm -rf /workspace/home/.cache /tmp/.prime
COPY package.json package-lock.json /opt/reify/pi-cad/
RUN cd /opt/reify/pi-cad && npm ci --omit=dev --ignore-scripts
COPY . /opt/reify/pi-cad/
# PI_CAD_BASE_RUNTIME=1 skips the simulation extra and Blender (out of scope for stage 1).
# PI_CAD_WORKFLOW_HOME puts the default workflow under /opt/reify/defaults; entrypoint.sh copies it into the user home.
RUN cd /opt/reify/pi-cad \
 && PI_CAD_BASE_RUNTIME=1 PI_CAD_WORKFLOW_HOME=/opt/reify/defaults npm run setup:python \
 && rm -rf /workspace/home/.cache

# 7. FreeCAD part backend. The script comes from the FreeCAD backend branch (see cloud/deploy/README.md).
#    PI_CAD_FREECAD_HOME selects /opt/reify/freecad. The script never uses sudo.
RUN cd /opt/reify/pi-cad \
 && PI_CAD_FREECAD_HOME=/opt/reify/freecad bash scripts/bootstrap-freecad.sh \
 && rm -rf /opt/reify/freecad/mamba-root/pkgs

# 8. Workspace gateway (cloud/workspace-gateway, inside the pi-cad tree so ../protocol resolves).
RUN cd /opt/reify/pi-cad/cloud/workspace-gateway \
 && npm ci \
 && npm run build --if-present \
 && rm -rf /root/.npm

# 9. Entrypoint, then make /opt/reify read-only for everyone except root.
COPY cloud/image/entrypoint.sh /opt/reify/entrypoint.sh
RUN chmod 0755 /opt/reify/entrypoint.sh \
 && find /opt/reify -xdev ! -type l \( -perm /022 -o ! -perm -444 -o \( -type d ! -perm -111 \) \) \
      -exec chmod go-w,a+rX {} +

ENV HOME=/workspace/home \
    UV_NO_SYNC=1 \
    PI_CAD_REPO=/opt/reify/pi-cad \
    PI_CAD_FREECAD_HOME=/opt/reify/freecad \
    PI_CAD_ASI_HOME=/opt/reify/asi \
    PRIME_AGENT_REPO=/opt/reify/prime-agent \
    PRIME_AGENT_CODING_AGENT_DIR=/workspace/home/.prime/agent \
    PRIME_AGENT_SESSION_DIR=/workspace/home/.prime/agent/sessions \
    PRIME_AGENT_KERNEL_VENV=/workspace/home/.prime/agent/kernel-venv \
    PI_OFFLINE=1

USER reify
WORKDIR /workspace
EXPOSE 7000

ENTRYPOINT ["tini", "--", "/opt/reify/entrypoint.sh"]
