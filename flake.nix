{
  description = "jerrito — stupid-minimal little helper for small local models (command: j)";

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
          name = "j";
          runtimeInputs = [
            pkgs.nodejs_24
            (llama pkgs cpu)
            pkgs.git
            pkgs.universal-ctags   # read outline=true: symbol index for code files
          ];
          # HELPER_PROG is what usage/errors call themselves; the wrapped node
          # cannot see the name it was invoked as otherwise
          text = ''export JERRITO_PROG=j; exec node ${./jerrito.mjs} "$@"'';
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
            universal-ctags   # read outline=true
          ];

          shellHook = ''
            mkdir -p .direnv/bin
            printf '#!/bin/sh\nexport JERRITO_PROG=j\nexec node "%s/jerrito.mjs" "$@"\n' "$PWD" > .direnv/bin/j
            chmod +x .direnv/bin/j
            rm -f .direnv/bin/jelper
            export PATH="$PWD/.direnv/bin:$PATH"
            echo "jerrito dev shell · command: j · $(node -v) · llama.cpp $(llama-server --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ready)"
          '';
        };
      });

      # self-contained for `nix run` / `nix profile install`
      packages = forAll (pkgs: {
        default = mkPackage pkgs false;
        cpu = mkPackage pkgs true;
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/j";
        };
      });

      # `nixpkgs.overlays = [ inputs.jerrito.overlays.default ];` -> pkgs.j, built
      # against *your* nixpkgs instead of pulling a second copy of it
      overlays.default = final: prev: {
        j = mkPackage final false;
        j-cpu = mkPackage final true;
      };

      # NixOS: `imports = [ inputs.jerrito.nixosModules.default ];` then
      # `programs.jerrito.enable = true;`
      nixosModules.default =
        { config, lib, pkgs, ... }:
        {
          options.programs.jerrito = {
            enable = lib.mkEnableOption "jerrito, a stupid-minimal local-model CLI (installs `j`)";
            gpu = lib.mkOption {
              type = lib.types.bool;
              default = true;
              description = "Enable graphics drivers so llama.cpp can offload to the GPU (Vulkan on Linux, Metal on macOS).";
            };
            package = lib.mkOption {
              type = lib.types.package;
              default = pkgs.j;
              defaultText = lib.literalExpression "pkgs.j";
              description = "Package to install. Use pkgs.j-cpu for a CPU-only build.";
            };
          };

          config = lib.mkIf config.programs.jerrito.enable {
            nixpkgs.overlays = [ self.overlays.default ];
            environment.systemPackages = [ config.programs.jerrito.package ];
            hardware.graphics.enable = lib.mkIf config.programs.jerrito.gpu (lib.mkDefault true);
            # the man tool is only as good as the system's man pages: with
            # documentation.enable = false the docs module does not link
            # /share/man, so man-db finds no pages at all (exit 16 for every
            # query). jerrito's value case for man makes docs worth having;
            # hosts that really want it off can still override this
            documentation.enable = lib.mkDefault true;
          };
        };
    };
}
