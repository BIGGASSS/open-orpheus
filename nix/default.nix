{ pkgs }:
let
  inherit (pkgs) lib stdenv;
  sources = lib.importJSON ./sources.json;
  manifest = lib.importJSON ../package.json;
  platform = stdenv.hostPlatform.node.platform;
  arch = stdenv.hostPlatform.node.arch;
  system = stdenv.hostPlatform.system;
  nodejs = pkgs.nodejs_24;
  pnpm = pkgs.pnpm_11.override {
    inherit (sources.pnpm) version hash;
    nodejs-slim = nodejs;
  };
  rust = pkgs.rust-bin.stable."1.98.1".default.override {
    extensions = [
      "clippy"
      "rustfmt"
    ];
    targets = [ "wasm32-unknown-unknown" ];
  };
  rustPlatform = pkgs.makeRustPlatform {
    cargo = rust;
    rustc = rust;
  };
  wasm-bindgen = rustPlatform.buildRustPackage {
    pname = "wasm-bindgen-cli";
    inherit (sources.wasm-bindgen) version cargoHash;
    src = pkgs.fetchCrate {
      pname = "wasm-bindgen-cli";
      inherit (sources.wasm-bindgen) version hash;
    };
    nativeBuildInputs = [ pkgs.pkg-config ];
    buildInputs = [ pkgs.openssl ] ++ lib.optionals stdenv.hostPlatform.isDarwin [ pkgs.curl ];
    doCheck = false; # Tests require the upstream monorepo, not the published crate.
  };

  # The derivation source excludes local data, build products, node_modules,
  # and proprietary resource packs. Use the Git flake, not an unfiltered path: input.
  src = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      let
        rel = lib.removePrefix (toString ../. + "/") (toString path);
        top = builtins.head (lib.splitString "/" rel);
        name = baseNameOf path;
      in
      builtins.elem top [
        "assets"
        "gui"
        "modules"
        "plugins"
        "scripts"
        "src"
        "types"
        "test"
        "__test__"
        "__mocks__"
        "patches"
        "package.json"
        "pnpm-lock.yaml"
        "pnpm-workspace.yaml"
        ".npmrc"
        "Cargo.toml"
        "Cargo.lock"
        "forge.config.ts"
        "forge.env.d.ts"
        "tsconfig.json"
        "vite.main.config.ts"
        "vite.preload.config.ts"
        "vite.renderer.config.ts"
        "vite.worklets.config.ts"
        "vitest.config.ts"
        "eslint.config.ts"
        "versions.json"
        "LICENSE"
        ".gitignore"
        ".prettierignore"
        ".prettierrc"
      ]
      && !(builtins.elem name [
        "node_modules"
        "dist"
        ".svelte-kit"
        ".vite"
        "target"
      ])
      && !(lib.hasSuffix ".node" name)
      && !(lib.hasSuffix ".tsbuildinfo" name);
  };
  # Lint documentation/CI/build definitions too, without putting them in the
  # application source (and invalidating the application on documentation edits).
  lintSrc = lib.cleanSourceWith {
    src = ../.;
    filter =
      path: type:
      src.filter path type
      ||
        builtins.elem
          (builtins.head (lib.splitString "/" (lib.removePrefix (toString ../. + "/") (toString path))))
          [
            ".github"
            "docs"
            "nix"
            "flake.nix"
            "flake.lock"
            "README.md"
            "CONTRIBUTING.md"
          ];
  };
  pnpmDeps = pkgs.fetchPnpmDeps {
    pname = "open-orpheus";
    inherit src pnpm;
    fetcherVersion = 4;
    hash = sources.pnpmDepsHash;
  };
  cargoDeps = rustPlatform.importCargoLock {
    lockFile = ../Cargo.lock;
    outputHashes."avs3a-0.1.0" = sources.avs3aHash;
  };
  electronZip = pkgs.fetchurl {
    url = "https://github.com/electron/electron/releases/download/v${sources.electron.version}/electron-v${sources.electron.version}-${platform}-${arch}.zip";
    sha256 = sources.electron.hashes.${system};
  };
  electronZipDir = pkgs.linkFarm "electron-zip" [
    {
      name = "electron-v${sources.electron.version}-${platform}-${arch}.zip";
      path = electronZip;
    }
  ];
  # Includes dlopen dependencies (GTK4, Fontconfig, graphics, audio), not only
  # DT_NEEDED entries. Keep in sync when updating Electron.
  runtimeLibraries = with pkgs; [
    alsa-lib
    at-spi2-atk
    cairo
    cups
    dbus
    expat
    fontconfig
    freetype
    gdk-pixbuf
    glib
    gtk3
    gtk4
    nss
    nspr
    libx11
    libxcb
    libxcomposite
    libxdamage
    libxext
    libxfixes
    libxrandr
    libxkbfile
    pango
    pciutils
    systemd
    libnotify
    pipewire
    libsecret
    libpulseaudio
    speechd-minimal
    libdrm
    libgbm
    libxkbcommon
    libxshmfence
    libGL
    vulkan-loader
    stdenv.cc.cc
  ];
  linuxNativeInputs = with pkgs; [
    autoPatchelfHook
    wrapGAppsHook3
  ];
  toolInputs = [
    nodejs
    pnpm
    rust
    wasm-bindgen
    pkgs.pkg-config
  ];
  libraryInputs = lib.optionals stdenv.hostPlatform.isLinux runtimeLibraries;

  patchElectron = directory: ''
    # ANGLE dlopens these libraries; autoPatchelf only sees DT_NEEDED.
    for library in ${directory}/lib{EGL,GLESv2}.so; do
      patchelf --add-rpath "${
        lib.makeLibraryPath [
          pkgs.libGL
          pkgs.pciutils
          pkgs.vulkan-loader
        ]
      }" "$library"
    done
    ln -sfn ${lib.getLib pkgs.vulkan-loader}/lib/libvulkan.so.1 ${directory}/libvulkan.so.1
  '';

  # Register from preFixup, after setup hooks have registered their fixups.
  # A plain postFixup runs BEFORE autoPatchelf's postFixupHooks and loses
  # dlopen-only RPATHs; on Darwin signing must likewise be the final operation.
  afterFixups = script: ''
    finalizePackage() {
      ${script}
    }
    postFixupHooks+=(finalizePackage)
  '';

  # A patched, independent runtime for `pnpm start`, never modified by Forge.
  electron = stdenv.mkDerivation {
    pname = "open-orpheus-electron";
    version = sources.electron.version;
    src = electronZip;
    nativeBuildInputs = [
      pkgs.unzip
      pkgs.makeWrapper
    ]
    ++ lib.optionals stdenv.hostPlatform.isLinux linuxNativeInputs;
    buildInputs = libraryInputs;
    runtimeDependencies = map lib.getLib libraryInputs;
    dontUnpack = true;
    dontBuild = true;
    dontStrip = true;
    dontWrapGApps = true;
    installPhase = ''
      mkdir -p $out/libexec/electron $out/bin
      unzip -q $src -d $out/libexec/electron
    '';
    preFixup = ''
      makeWrapper $out/libexec/electron/${
        if stdenv.hostPlatform.isDarwin then "Electron.app/Contents/MacOS/Electron" else "electron"
      } $out/bin/electron "''${gappsWrapperArgs[@]}"
      # electron/index.js falls back to `electron` when install scripts were
      # skipped. A previously installed path.txt may use the Darwin bundle path.
      mkdir -p $out/share/electron/Electron.app/Contents/MacOS
      ln -s $out/bin/electron $out/share/electron/electron
      ln -s $out/bin/electron $out/share/electron/Electron.app/Contents/MacOS/Electron
    ''
    + lib.optionalString stdenv.hostPlatform.isLinux (
      afterFixups (patchElectron "$out/libexec/electron")
    );
    passthru.dist = "${electron}/share/electron";
  };

  common = {
    inherit src pnpmDeps cargoDeps;
    version = manifest.version;
    nativeBuildInputs =
      toolInputs
      ++ [
        pkgs.pnpmConfigHook
        rustPlatform.cargoSetupHook
        pkgs.makeWrapper
        pkgs.unzip
      ]
      ++ lib.optionals stdenv.hostPlatform.isLinux linuxNativeInputs
      ++ lib.optionals stdenv.hostPlatform.isDarwin [ pkgs.rcodesign ];
    buildInputs = libraryInputs;
    env = {
      ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
      ELECTRON_OVERRIDE_DIST_PATH = electron.dist;
      ELECTRON_ZIP_DIR = electronZipDir;
      NIX_BUILD_DARWIN_SIGNING = "1";
      CARGO_NET_OFFLINE = "true";
      npm_config_nodedir = "${nodejs}/include/node";
      CI = "true";
    };
    # Run prebuilt npm tools only after repairing their ELF search paths.
    preBuild =
      lib.optionalString stdenv.hostPlatform.isLinux ''
        # The extractor ships glibc and musl bindings in one package. Nix's
        # Electron is glibc-only; do not patch or retain the unused musl copy.
        find node_modules -name '*-musl.node' -delete
        autoPatchelf node_modules
      ''
      + ''
        export CARGO_TARGET_DIR="$PWD/target"
        export CARGO_BUILD_JOBS="$NIX_BUILD_CORES"
      '';
    dontWrapGApps = true;
    dontStrip = true;
    strictDeps = true;
  };
  buildModules = ''
    pnpm run build:modules
  '';

  open-orpheus = stdenv.mkDerivation (
    common
    // {
      pname = "open-orpheus";
      buildPhase = ''
        runHook preBuild
        ${buildModules}
        pnpm exec electron-forge package --platform=${platform} --arch=${arch}
        runHook postBuild
      '';
      installPhase = ''
        runHook preInstall
      ''
      + (
        if stdenv.hostPlatform.isDarwin then
          ''
            mkdir -p $out/Applications $out/bin
            cp -R out/open-orpheus-darwin-${arch}/open-orpheus.app $out/Applications/
          ''
        else
          ''
            mkdir -p $out/lib/open-orpheus $out/bin
            cp -R out/open-orpheus-linux-${arch}/. $out/lib/open-orpheus/
            # Keep Electron's default desktopName and the MPRIS desktop ID aligned.
            install -Dm644 ${./open-orpheus.desktop} $out/share/applications/open-orpheus.desktop
            install -Dm644 assets/io.github.yucling.open-orpheus.metainfo.xml $out/share/metainfo/io.github.yucling.open-orpheus.metainfo.xml
            for size in 256 512 1024; do
              install -Dm644 assets/icon_$size.png $out/share/icons/hicolor/''${size}x$size/apps/open-orpheus.png
            done
            install -Dm644 assets/icon.svg $out/share/icons/hicolor/scalable/apps/open-orpheus.svg
          ''
      )
      + ''
        install -Dm644 LICENSE $out/share/licenses/open-orpheus/LICENSE
        runHook postInstall
      '';
      preFixup =
        (
          if stdenv.hostPlatform.isDarwin then
            ''
              makeWrapper $out/Applications/open-orpheus.app/Contents/MacOS/open-orpheus $out/bin/open-orpheus
            ''
          else
            ''
              makeWrapper $out/lib/open-orpheus/open-orpheus $out/bin/open-orpheus \
                --prefix PATH : ${lib.makeBinPath [ pkgs.xdg-utils ]} \
                --prefix LD_LIBRARY_PATH : ${lib.makeLibraryPath [ pkgs.fontconfig ]} \
                "''${gappsWrapperArgs[@]}"
            ''
        )
        + afterFixups (
          if stdenv.hostPlatform.isDarwin then
            ''
              bash ${./sign-darwin.sh} "$out/Applications/open-orpheus.app"
            ''
          else
            patchElectron "$out/lib/open-orpheus"
        );
      runtimeDependencies = map lib.getLib libraryInputs;
      doInstallCheck = true;
      nativeInstallCheckInputs = [
        nodejs
      ]
      ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.desktop-file-utils ];
      installCheckPhase = ''
        runHook preInstallCheck
        node ${./check-package.mjs} "$out" ${platform}
        ${lib.optionalString stdenv.hostPlatform.isLinux ''
          desktop-file-validate $out/share/applications/*.desktop
          patchelf --print-rpath $out/lib/open-orpheus/libEGL.so | grep -F ${
            lib.makeLibraryPath [ pkgs.libGL ]
          }
          test "$(readlink $out/lib/open-orpheus/libvulkan.so.1)" = ${lib.getLib pkgs.vulkan-loader}/lib/libvulkan.so.1
        ''}
        runHook postInstallCheck
      '';
      passthru = {
        inherit
          pnpmDeps
          cargoDeps
          electron
          wasm-bindgen
          ;
      };
      meta = {
        inherit (manifest) description;
        homepage = "https://github.com/YUCLing/open-orpheus";
        license = lib.licenses.mit;
        mainProgram = "open-orpheus";
        platforms = [
          "x86_64-linux"
          "aarch64-linux"
          "aarch64-darwin"
        ];
        sourceProvenance = with lib.sourceTypes; [
          fromSource
          binaryNativeCode
        ];
      };
    }
  );
  mkCheck =
    name: commands:
    stdenv.mkDerivation (
      common
      // {
        pname = "open-orpheus-${name}";
        buildPhase = ''
          runHook preBuild
          ${commands}
          runHook postBuild
        '';
        installPhase = "touch $out";
        dontFixup = true;
      }
    );
in
assert sources.electron.version == manifest.devDependencies.electron;
assert lib.hasPrefix "pnpm@${sources.pnpm.version}+" manifest.packageManager;
assert
  (builtins.fromTOML (builtins.readFile ../Cargo.toml)).workspace.dependencies.wasm-bindgen
  == sources.wasm-bindgen.version;
{
  inherit open-orpheus;
  formatter = pkgs.nixfmt;
  checks = {
    application = open-orpheus;
    tests = mkCheck "tests" ''
      ${buildModules}
      pnpm test
      pnpm --dir modules/database test
      pnpm --dir modules/av3a test
    '';
    lint =
      (mkCheck "lint" ''
        pnpm --dir modules/lifecycle build
        pnpm --dir modules/audio-effect build
        pnpm --dir gui exec svelte-kit sync
        pnpm lint
        pnpm exec prettier --check .
      '').overrideAttrs
        { src = lintSrc; };
    infrastructure =
      pkgs.runCommand "open-orpheus-build-infrastructure"
        {
          nativeBuildInputs = [
            pkgs.nixfmt
            pkgs.shellcheck
            pkgs.actionlint
          ];
        }
        ''
          nixfmt --check ${../flake.nix} ${./default.nix}
          shellcheck ${./sign-darwin.sh}
          actionlint ${../.github/workflows/build.yml} ${../.github/workflows/checks.yml} ${../.github/workflows/release.yml}
          touch $out
        '';
    rust = mkCheck "rust" ''
      cargo fmt --all --check
      cargo clippy --locked --offline --workspace --all-targets -- -D warnings
      cargo test --locked --offline -p audio-effect
    '';
  };
  devShell = pkgs.mkShell {
    packages =
      toolInputs
      ++ [
        electron
        pkgs.git
        pkgs.nixfmt
        pkgs.bash
        pkgs.coreutils
        pkgs.zstd
      ]
      ++ lib.optionals stdenv.hostPlatform.isLinux [ pkgs.autoPatchelfHook ];
    buildInputs = libraryInputs;
    ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
    ELECTRON_OVERRIDE_DIST_PATH = electron.dist;
    ELECTRON_ZIP_DIR = electronZipDir;
    npm_config_nodedir = "${nodejs}/include/node";
    shellHook = lib.optionalString stdenv.hostPlatform.isLinux ''
      export LD_LIBRARY_PATH="${
        lib.makeLibraryPath [
          stdenv.cc.cc
          pkgs.fontconfig
        ]
      }''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
    '';
  };
}
