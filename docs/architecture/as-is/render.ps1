[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateScript({ Test-Path -LiteralPath $_ -PathType Leaf })]
  [string]$PlantUmlJar
)

$ErrorActionPreference = 'Stop'
$architectureDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$sources = Get-ChildItem -LiteralPath $architectureDir -File -Filter '*.puml' |
  Where-Object { $_.Name -match '^\d{2}-' } |
  Sort-Object Name

if ($sources.Count -eq 0) {
  throw '렌더링할 번호형 PlantUML 원본을 찾지 못했습니다.'
}

Push-Location $architectureDir
try {
  & java '-Djava.awt.headless=true' -jar $PlantUmlJar -tsvg -charset UTF-8 -o rendered $sources.FullName
  if ($LASTEXITCODE -ne 0) {
    throw "PlantUML 렌더링 실패: exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Host "Rendered $($sources.Count) diagrams to $architectureDir\rendered"
