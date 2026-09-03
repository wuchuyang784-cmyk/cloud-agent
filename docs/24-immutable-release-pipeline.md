# Immutable release pipeline

`Platform Immutable Release` runs only after `Platform CI` succeeds on `main`,
or through an explicit manual dispatch. It publishes
`ghcr.io/lutao581314/bairui-platform` with a commit tag and records the image
digest, Platform commit, BaiLongma commit, contracts version and latest
PostgreSQL migration.

Production deployment must consume `image@sha256:digest`; the commit tag is not
an immutable deployment reference. The same digest runs both the Platform web
process and the independent Channel Worker.

The image receives OCI revision and dependency labels, an SPDX JSON SBOM, a
GitHub provenance attestation and a blocking Trivy scan for fixed high or
critical vulnerabilities. The final runtime stage removes npm and Corepack
because neither Platform nor
Channel Worker installs packages at runtime. Build stages retain the package
manager; the production image does not carry that unnecessary attack surface.

The integration job pulls the exact digest and starts PostgreSQL, Platform and
Channel Worker. It requires:

- Platform `/ready` to report PostgreSQL readiness;
- Channel Worker `/ready` to report a successful dynamic inventory load;
- the release migration to exist in `schema_migrations`;
- durable channel inbox, outbox, receipt and Worker credential tables.

The resulting `platform-release-manifest.json` is required evidence for
staging, production deployment and rollback. This workflow does not substitute
for the separate real Runtime, Hermes and Provider acceptance gates.

## Product distribution

`BaiRui Product Distribution` is the only workflow allowed to create a product
version tag and GitHub Release. It consumes successful Platform and Agent image
digests, verifies Platform provenance and the Cosign-signed Runtime/Hermes SLSA
attestations, resolves PostgreSQL and Caddy to immutable digests, and emits one
cross-repository `release-manifest.json`.

The release contains `install.sh`, `bairui-agent.tar.gz`, `SHA256SUMS`, the
manifest and provenance verification evidence. The installer verifies the
archive, generates local secrets, applies PostgreSQL migrations, registers the
Server Agent through the authenticated Platform API and preserves the previous
release for rollback. A package version in `package.json`, a Git tag, or a GHCR
tag by itself is not an installable BaiRui release.
