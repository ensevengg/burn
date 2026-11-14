# Install burn on Windows: burn-report and its burn-events exporter from the
# latest GitHub release, started now and at every sign-in, then the QR code
# to scan on the phone. Offers the same for each WSL distro. No
# administrator rights needed. Run it again to upgrade.
#
#   irm https://github.com/ensevengg/burn/releases/latest/download/install.ps1 | iex
#
# Overrides: $env:BURN_INSTALL_DIR (default %LOCALAPPDATA%\burn\bin),
#            $env:BURN_RELEASE_TAG (a release such as v0.2.0; default: the latest),
#            $env:BURN_RELEASE_BASE (a download URL to use instead of a release),
#            $env:BURN_NO_SERVICE = '1' (install the binaries only),
#            $env:BURN_WSL = 'yes' | 'no' (answer the WSL questions up front;
#              'yes' also turns on mirrored networking, restarting WSL).

# A script block, so `irm | iex` leaves no variables in the session, and a
# failure prints one line instead of a stack.
& {
  try {
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'  # Invoke-WebRequest is slow with it
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

    $repo = 'ensevengg/burn'
    if ($env:BURN_RELEASE_BASE) { $base = $env:BURN_RELEASE_BASE.TrimEnd('/') }
    elseif ($env:BURN_RELEASE_TAG) { $base = "https://github.com/$repo/releases/download/$($env:BURN_RELEASE_TAG)" }
    else { $base = "https://github.com/$repo/releases/latest/download" }
    if ($env:BURN_INSTALL_DIR) { $dir = $env:BURN_INSTALL_DIR } else { $dir = Join-Path $env:LOCALAPPDATA 'burn\bin' }

    function Ask([string]$question, [string]$preset) {
      if ($preset -eq 'yes') { return $true }
      if ($preset -eq 'no') { return $false }
      $answer = Read-Host "$question [Y/n]"
      return -not ($answer -match '^\s*n')
    }

    if (-not [Environment]::Is64BitOperatingSystem) {
      Write-Host 'burn needs 64-bit Windows.' -ForegroundColor Red
      return
    }

    # ---- Download and verify ------------------------------------------------
    $assets = @{
      'burn-report-windows-x64.exe' = 'burn-report.exe'
      'burn-events-x86_64-pc-windows-msvc.exe' = 'burn-events.exe'
    }
    $tmp = Join-Path ([IO.Path]::GetTempPath()) ("burn-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      Write-Host "Downloading burn from $base"
      foreach ($name in @($assets.Keys) + 'SHA256SUMS') {
        try { Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile (Join-Path $tmp $name) }
        catch { throw "Could not download $base/$name ($($_.Exception.Message))" }
      }
      # Refuse a binary that does not match the published checksum.
      $sums = @{}
      foreach ($line in Get-Content (Join-Path $tmp 'SHA256SUMS')) {
        $parts = $line -split '\s+', 2
        if ($parts.Count -eq 2) { $sums[$parts[1].TrimStart('*')] = $parts[0].ToLowerInvariant() }
      }
      foreach ($name in $assets.Keys) {
        $have = (Get-FileHash -Algorithm SHA256 (Join-Path $tmp $name)).Hash.ToLowerInvariant()
        if ($sums[$name] -ne $have) { throw "checksum mismatch for $name; nothing was installed" }
      }

      # ---- Install --------------------------------------------------------
      New-Item -ItemType Directory -Force -Path $dir | Out-Null
      $reporter = Join-Path $dir 'burn-report.exe'
      # burn-report looks for burn-events beside itself. Both are staged
      # first, so a failed copy changes nothing.
      $targets = @($assets.Keys | ForEach-Object { Join-Path $dir $assets[$_] })
      try {
        foreach ($name in $assets.Keys) { Copy-Item -Force (Join-Path $tmp $name) "$(Join-Path $dir $assets[$name]).new" }
      }
      catch {
        foreach ($target in $targets) { Remove-Item -Force "$target.new" -ErrorAction SilentlyContinue }
        throw "could not write to $dir ($($_.Exception.Message)); nothing was changed"
      }
      # An upgrade restarts the reporter on the new files below. With
      # BURN_NO_SERVICE its autostart is left as it is; the running copy
      # keeps the old version until it restarts.
      $upgrade = Test-Path $reporter
      $restart = $upgrade -and $env:BURN_NO_SERVICE -ne '1'
      if ($restart) {
        & $reporter uninstall-service | Out-Null
        Get-Process burn-report, burn-events -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
      }
      # Windows renames a running executable but will not overwrite it.
      $moved = @()
      try {
        foreach ($target in $targets) {
          Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue
          if (Test-Path $target) { Move-Item -Force $target "$target.old" }
          $moved += $target
          Move-Item -Force "$target.new" $target
        }
      }
      catch {
        # Both old files back, never a new reporter beside an old exporter.
        foreach ($target in $moved) {
          if (Test-Path "$target.old") { Move-Item -Force "$target.old" $target }
        }
        foreach ($target in $targets) { Remove-Item -Force "$target.new" -ErrorAction SilentlyContinue }
        if ($restart) { & $reporter install-service | Out-Null }
        throw "could not replace the files in $dir ($($_.Exception.Message)); the previous version is back in place"
      }
      foreach ($target in $targets) { Remove-Item -Force "$target.old" -ErrorAction SilentlyContinue }
      Write-Host "Installed $dir\burn-report.exe and $dir\burn-events.exe"
    }
    finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }

    # On PATH for new terminals (user scope) and this one.
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (-not (($userPath -split ';') -contains $dir)) {
      $newPath = if ($userPath) { "$userPath;$dir" } else { $dir }
      [Environment]::SetEnvironmentVariable('Path', $newPath, 'User')
    }
    if (-not (($env:Path -split ';') -contains $dir)) { $env:Path = "$env:Path;$dir" }

    $tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue) -or
      ($env:ProgramFiles -and (Test-Path (Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe')))
    if (-not $tailscale) {
      Write-Host ''
      Write-Host 'Tailscale was not found. Install it and sign in (https://tailscale.com/download);' -ForegroundColor Yellow
      Write-Host 'burn waits for it, so nothing needs restarting afterwards.' -ForegroundColor Yellow
    }

    if ($env:BURN_NO_SERVICE -eq '1') {
      Write-Host ''
      Write-Host "Start it with: burn-report install-service"
      return
    }

    # Starts the reporter now and at every sign-in, then prints the QR code.
    Write-Host ''
    & $reporter install-service
    if ($LASTEXITCODE -ne 0) {
      Write-Host "The reporter is installed but could not be set to start by itself. Run it with: burn-report daemon" -ForegroundColor Red
      return
    }

    # ---- WSL ----------------------------------------------------------------
    # Each distro is a machine of its own to burn (its agents keep their own
    # history), so each gets its own reporter.
    $distros = @()
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
      $env:WSL_UTF8 = '1'  # otherwise wsl.exe lists names in UTF-16
      # Windows PowerShell turns native stderr into an error under 'Stop'.
      $listed = $null
      try { $listed = & { $ErrorActionPreference = 'Continue'; & wsl.exe --list --quiet 2>$null } } catch { }
      if ($LASTEXITCODE -eq 0 -and $listed) {
        $distros = @($listed | ForEach-Object { ($_ -replace "`0", '').Trim() } |
          Where-Object { $_ -and $_ -notmatch '^docker-desktop' })
      }
    }
    if ($distros.Count -gt 0) {
      Write-Host ''
      Write-Host "WSL found: $($distros -join ', ')"
      $wantWsl = Ask 'Install burn in WSL too? AI agents run there keep their own history.' $env:BURN_WSL
      if ($wantWsl) {
        # WSL reaches the tailnet through Windows' Tailscale only with mirrored
        # networking (or with Tailscale installed inside the distro).
        $wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
        # Read and written as UTF-8: Windows PowerShell's defaults would turn
        # non-ASCII paths (C:\Users\Jürgen) into '?'.
        $utf8 = New-Object Text.UTF8Encoding $false
        $text = if (Test-Path $wslconfig) { [IO.File]::ReadAllText($wslconfig) } else { '' }
        if ($text -notmatch '(?im)^\s*networkingMode\s*=\s*mirrored') {
          Write-Host ''
          Write-Host 'Your phone can reach WSL only with mirrored networking (Windows 11 22H2 or later).'
          if (Ask 'Turn it on? This restarts WSL now, closing open WSL windows.' $env:BURN_WSL) {
            if ($text -match '(?im)^[ \t]*networkingMode[ \t]*=[^\r\n]*') {
              $text = $text -replace '(?im)^[ \t]*networkingMode[ \t]*=[^\r\n]*', 'networkingMode=mirrored'
            } elseif ($text -match '(?im)^[ \t]*\[wsl2\][ \t]*([#;][^\r\n]*)?\r?$') {
              # The header may carry a comment: [wsl2] # tuning
              $text = $text -replace '(?im)^([ \t]*\[wsl2\][ \t]*(?:[#;][^\r\n]*)?)(\r?)$', "`$1`$2`nnetworkingMode=mirrored`$2"
            } else {
              $text = $text.TrimEnd() + "`r`n`r`n[wsl2]`r`nnetworkingMode=mirrored`r`n"
            }
            if (Test-Path $wslconfig) { Copy-Item -Force $wslconfig "$wslconfig.bak" }
            [IO.File]::WriteAllText($wslconfig, $text.TrimStart(), $utf8)
            & wsl.exe --shutdown
            Write-Host "Updated $wslconfig (the previous copy is $wslconfig.bak)"
          } else {
            Write-Host 'Skipped: install Tailscale inside the distro instead, or the phone will not reach it.' -ForegroundColor Yellow
          }
        }
        # The Linux installer, run inside each distro: a fresh install takes
        # the first free port from 8788, since every distro shares this
        # machine's tailnet address. Downloaded first, not piped, so a failed
        # download fails the distro instead of running an empty script.
        $forward = ''
        if ($env:BURN_RELEASE_BASE) { $forward = "BURN_RELEASE_BASE=$($env:BURN_RELEASE_BASE) " }
        elseif ($env:BURN_RELEASE_TAG) { $forward = "BURN_RELEASE_TAG=$($env:BURN_RELEASE_TAG) " }
        # No quotes inside: Windows PowerShell mangles them on the way to wsl.exe.
        $script = "f=`$(mktemp) && curl -fsSL $base/install.sh -o `$f && env ${forward}sh `$f; s=`$?; rm -f `$f; exit `$s"
        foreach ($distro in $distros) {
          Write-Host ''
          Write-Host "== WSL: $distro ==" -ForegroundColor Cyan
          & wsl.exe -d $distro --exec sh -c $script
          if ($LASTEXITCODE -ne 0) {
            Write-Host "WSL $distro was not set up. Inside it, run: curl -fsSL $base/install.sh | sh" -ForegroundColor Yellow
          }
        }
      }
    }

    Write-Host ''
    Write-Host "No app yet? Install it on your phone: https://github.com/$repo/releases/latest/download/burn.apk"
    Write-Host 'Show the QR code again any time with: burn-report pair'
  }
  catch {
    Write-Host "burn: $($_.Exception.Message)" -ForegroundColor Red
  }
}
