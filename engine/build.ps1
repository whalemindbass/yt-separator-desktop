# yss-engine 빌드 — 한글 경로 juceaide 크래시 회피 위해 ASCII 경로(C:\yss)로 복사 후 빌드
#   .\build.ps1                     # ASIO 없이
#   .\build.ps1 -AsioSdk C:\path\ASIOSDK\common   # ASIO 켜기
#   .\build.ps1 -Run stem1.wav stem2.wav          # 빌드 후 실행
param(
  [string]$AsioSdk = "C:\Users\wkq32\Downloads\ASIOSDK\common",
  [string[]]$Run,
  [string]$Work = "C:\yss"
)
$ErrorActionPreference = "Stop"
$src = $PSScriptRoot

# 소스만 복사 (build/_deps 제외). robocopy exit<8 = 성공.
robocopy $src $Work /MIR /XD build _deps .git | Out-Null
if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE)" }

$cfg = @("-S", $Work, "-B", "$Work\build")
if ($AsioSdk -and (Test-Path "$AsioSdk\asio.h")) {
  $cfg += @("-DYSS_ENABLE_ASIO=ON", "-DYSS_ASIO_SDK_DIR=$AsioSdk")
  Write-Host "ASIO: on ($AsioSdk)"
} else { Write-Host "ASIO: off" }

cmake @cfg
cmake --build "$Work\build" --config Release
$exe = "$Work\build\yss-engine_artefacts\Release\yss-engine.exe"
Write-Host "built: $exe"
if ($PSBoundParameters.ContainsKey('Run')) { & $exe @Run }
