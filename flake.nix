{
  description = "helper — stupid-minimal terminal helper for small local models";

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
      llama = pkgs: if pkgs.stdenv.hostPlatform.isLinux then pkgs.llama-cpp-vulkan else pkgs.llama-cpp;
    in
    {
      devShells = forAll (pkgs: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            nodejs_24
            (llama pkgs)
            curl
            git
          ];

          shellHook = ''
            mkdir -p .direnv/bin
            printf '#!/bin/sh\nexec node "%s/helper.mjs" "$@"\n' "$PWD" > .direnv/bin/helper
            chmod +x .direnv/bin/helper
            export PATH="$PWD/.direnv/bin:$PATH"
            echo "helper dev shell · $(node -v) · llama.cpp $(llama-server --version 2>&1 | head -1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' || echo ready)"
          '';
        };
      });

      # self-contained helper for `nix run` / `nix profile install`
      packages = forAll (pkgs: {
        default = pkgs.writeShellApplication {
          name = "helper";
          runtimeInputs = [
            pkgs.nodejs_24
            (llama pkgs)
            pkgs.git
          ];
          text = ''exec node ${./helper.mjs} "$@"'';
        };
      });

      apps = forAll (pkgs: {
        default = {
          type = "app";
          program = "${self.packages.${pkgs.stdenv.hostPlatform.system}.default}/bin/helper";
        };
      });
    };
}