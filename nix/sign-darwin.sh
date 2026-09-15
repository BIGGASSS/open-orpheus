#!/usr/bin/env bash
# Final, offline ad-hoc signing for the installed Electron .app.
# Nix: nativeBuildInputs = [ pkgs.rcodesign ];
# Run in the LAST postFixupHooks entry: bash ${./sign-darwin.sh} "$out/Applications/open-orpheus.app"
# Keep dontStrip = true and do not remove Electron's embedded signatures first:
# rcodesign imports their per-binary entitlements (including JIT), runtime flags
# and runtime version, even when Forge's edits have invalidated their hashes.
# Do not supply one blanket entitlements plist for all helpers/frameworks.
#
# Checked against nixpkgs rcodesign 0.29.0 (apple-codesign):
# - signing_settings.rs: import_settings_from_macho preserves the above metadata.
# - code_resources.rs: seal_rules2_file also signs Mach-O files in Resources,
#   including native .node addons in app.asar.unpacked, before sealing resources.
# - bundle_signing.rs: nested bundles/framework versions are signed inside-out.
# https://gregoryszorc.com/docs/apple-codesign/stable/apple_codesign_rcodesign_signing.html
set -euo pipefail

if [[ $# != 1 ]]; then
  printf 'Usage: %s /path/to/application.app\n' "$0" >&2
  exit 2
fi

app=$(cd -- "$1" && pwd -P)
if [[ $app != *.app || ! -f "$app/Contents/Info.plist" || ! -d "$app/Contents/MacOS" ]]; then
  printf 'Not a macOS application bundle: %s\n' "$app" >&2
  exit 1
fi

# An implicit user/project config or RCODESIGN_* environment variable could
# select a certificate, remote signer, exclusions, or replacement entitlements.
# Disable both configuration sources; no identity means ad-hoc signing.
for variable in "${!RCODESIGN_@}"; do
  unset "$variable"
done

# Write a new tree rather than rewrite potentially cached Mach-O inodes on
# Darwin. A sibling staging directory keeps the final renames on one filesystem.
# Do not discard the original bundle until signing has succeeded.
stage=$(mktemp -d "${app%/*}/.sign-darwin.XXXXXX")
signed="$stage/${app##*/}"
cleanup() {
  local status=$?
  if [[ -d "$stage/original" && ! -e "$app" ]]; then
    if ! mv -- "$stage/original" "$app"; then
      printf 'Could not restore original bundle; retained at %s\n' "$stage/original" >&2
      return 1
    fi
  fi
  rm -rf -- "$stage"
  return "$status"
}
trap cleanup EXIT

# Sign IN PLACE in a fresh copy. In 0.29.0, separate input/output trees can
# seal legacy (v1) resource hashes from the unsigned source of native addons,
# while v2 hashes use the signed output. In-place signing keeps both correct.
# cp -a also preserves framework symlinks, permissions and empty directories.
cp -a -- "$app" "$signed"

# Recursive signing is the default, including nested helpers, frameworks,
# dylibs and native addons. Explicitly disable even optional timestamp traffic.
# No Apple codesign, keychain, certificate, notarization, or network is needed.
rcodesign --config-file /dev/null sign --timestamp-url none "$signed"

mv -- "$app" "$stage/original"
mv -- "$signed" "$app"

# Do not use `rcodesign verify "$app"`: 0.29.0 only verifies individual Mach-O
# files and explicitly warns of misleading results. Full bundle verification
# needs Apple's codesign --verify --deep --strict on a real Darwin host, plus a
# launch/JIT/native-addon smoke test; this script does not claim to replace it.
