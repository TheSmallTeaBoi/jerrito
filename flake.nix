{
  description = "helper — stupid-minimal terminal helper for small local models (command: h)";

  # nixos-unstable, pinned by flake.lock (commit it).
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "x86_64-darwin"
        "aarch64-darwin"
      ];
      forAll = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});

      # Vulkan build on Linux: works on NVIDIA/AMD/Intel offload with no CUDA SDK,
      # and is in the binary cache. macOS keeps the default (Metal).
      llama = pkgs: cpu: if cpu || !pkgs.stdenv.hostPlatform.isLinux then pkgs.llama-cpp else pkgs.llama-cpp-vulkan;

      # one package, two flavours: default (GPU offload) and cpu
      mkPackage =
        pkgs: cpu:
        pkgs.writeShellApplication {
          name = "h";
          runtimeInputs = [
            pkgs.nodejs_24
            (llama pkgs cpu)
            pkgs.git
          ];
          # HELPER_PROG is what usage/errors call themselves; the wrapped node
          # cannot see the name it was invoked as otherwise
          text = ''export HELPER_PROG=h; exec node ${./helper.mjs} "$@"'';
        };
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            (llama pkgs false)
            curl
            git
          ];

          shellHook = ''
            mkdir -p .direnv/bin
            printf '#!/bin/sh\nexport HELPER_PROG=h\nexec node "%s/helper.mjs" "$@"\n' "$PWD" > .direnv/bin/h
            chmod +x .direnv/bin/h
            rm -f .direnv/bin/helper
            export PATH="$PWD/.direnv/bin:$PATH"
            echo "helper dev shell · command: h · $(node -v) · llama.cpp $(llama-server --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ready)"
          '';
        };
      });

      # self-contained helper for `nix run` / `nix profile install`
      packages = forAll (pkgs: {
        default = mkPackage pkgs false;
        cpu = mkPackage pkgs true;
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/h";
        };
      });

      # `nixpkgs.overlays = [ inputs.helper.overlays.default ];` -> pkgs.h, built
      # against *your* nixpkgs instead of pulling a second copy of it
      overlays.default = final: prev: {
        h = mkPackage final false;
        h-cpu = mkPackage final true;
      };

      # NixOS: `imports = [ inputs.helper.nixosModules.default ];` then
      # `programs.helper.enable = true;`
      nixosModules.default =
        { config, lib, pkgs, ... }:
        {
          options.programs.helper = {
            enable = lib.mkEnableOption "helper, a stupid-minimal local-model CLI (installs `h`)";
            gpu = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Enable graphics drivers so llama.cpp can offload to the GPU (Vulkan on Linux, Metal on macOS).";
            };
            package = lib.mkOption {
              type = lib.types.package;
              default = pkgs.h;
              defaultText = lib.literalExpression "pkgs.h";
              description = "Package to install. Use pkgs.h-cpu for a CPU-only build.";
            };
          };

          config = lib.mkIf config.programs.helper.enable {
            nixpkgs.overlays = [ self.overlays.default ];
            environment.systemPackages = [ config.programs.helper.package ];
            hardware.graphics.enable = lib.mkIf config.programs.helper.gpu (lib.mkDefault true);
          };
        };
    };
}
