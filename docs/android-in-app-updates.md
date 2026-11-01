# Android in-app updates: backend rollout

Implementation is in progress. Nothing in this runbook authorizes publication, enables app updates, or changes analytics collection.

## Default-off controls

- ANDROID_UPDATES_ENABLED=false: public GET /api/public/android-app/update returns state:disabled. Enable only after a verified first updater-enabled APK and owner approval.
- ANDROID_RELEASE_DOWNLOADS_ENABLED=false: existing website APK status/HEAD/GET routes keep their local-file behavior. After approval, true selects the validated GitHub stable release for status/download; an unavailable activated source fails explicitly rather than serving an older local APK.
- ANDROID_RELEASES_REPOSITORY=janeshkrish/resqnowfrontend: the public repository selected by the owner. No GitHub write token belongs in this backend.

GitHub release tags must be android-v<versionCode>, with resqnow.apk and android-release.json uploaded before publication. The manifest contract/fixtures and frontend design document define all required fields. Draft/prerelease/malformed/mismatched releases are never offered. Repository immutable-release settings are an owner setup step, not assumed enabled by source changes.

Discovery caches successful validated results for300seconds and failures for30seconds and coalesces concurrent misses. Network deadlines, JSON size limits, a maximum of3 redirects and exact HTTPS GitHub/CDN host allowlisting bound external work. Client parameters cannot select an upstream URL.

## Delivery and accounting

Website downloads stream with bounded buffers and at most4 simultaneous transfers per API process, with backpressure, idle/total deadlines, upstream/client cancellation, and validated range/content-length handling. Full GETs also verify the file checksum before completing the final bounded chunk. HEAD requests use validated metadata and do not fetch/count APK bytes. An incomplete/truncated/failed/aborted delivery does not increment accepted-delivery accounting. Successful ranges retain the existing download-session deduplication semantics; downloading does not prove installation.

Native APK-update transfers use release assets directly and are not website download sessions. The app independently validates package/version/SDK/signature and full-file SHA-256. Analytics flags, migration steps, privacy controls and identity storage are independent and must not be changed to enable updates.

## Verification and activation

Every refresh validates the latest pointer against the highest published stable Android tag in bounded GitHub history (up to10 pages of100 releases,1MiB/page, within the existing total5s deadline). Draft/prerelease reservations do not displace the current stable release. A stale/ambiguous/truncated/unavailable history fails closed, never selects an older fallback. The service also retains its highest validated immutable release identity across positive/negative cache expiry and across website/update consumers for the process lifetime. Cold starts validate published history again; the publication pipeline forbids tag/version reuse. Do not delete published release history as a rollback mechanism. Installed apps independently refuse lower version codes.

Run updater tests with node --test tests/android_release_manifest.test.js tests/android_release_service.test.js tests/android_updates_api.test.js tests/android_release_stream.test.js tests/app_analytics_download.test.js. These include real local HTTP transfers through an injected transport; no production release, APK replacement or database change is performed.

Before activation require the complete backend/frontend gates, Android update/cancellation/offline/data-retention acceptance, production public-certificate/version continuity and a verified hosted signing dry-run. Existing runtime/security findings also require fresh triage. Enable public delivery and update offers separately with explicit owner approval; both can be turned off independently. Never roll back an installed APK by publishing a lower versionCode or requiring uninstall.
