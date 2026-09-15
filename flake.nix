{
  description = "Open Orpheus — reproducible Electron, Rust and WASM builds";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    rust-overlay = {
      url = "github:oxalica/rust-overlay";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs =
    {
      self,
      nixpkgs,
      rust-overlay,
    }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      projects = forAllSystems (
        system:
        import ./nix {
          pkgs = import nixpkgs {
            inherit system;
            overlays = [ rust-overlay.overlays.default ];
          };
        }
      );
    in
    {
      packages = forAllSystems (system: {
        inherit (projects.${system}) open-orpheus;
        default = self.packages.${system}.open-orpheus;
      });
      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/open-orpheus";
          meta.description = "Launch Open Orpheus";
        };
      });
      devShells = forAllSystems (system: {
        default = projects.${system}.devShell;
      });
      checks = forAllSystems (system: projects.${system}.checks);
      formatter = forAllSystems (system: projects.${system}.formatter);
    };
}
