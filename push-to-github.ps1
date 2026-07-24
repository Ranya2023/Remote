<#
.SYNOPSIS
  Commits and pushes this project folder to GitHub.
#>

param(
    [string]$RepoUrl = "",
    [string]$Message = "Update $(Get-Date -Format 'yyyy-MM-dd HH:mm')",
    [string]$Branch = "main"
)

Set-Location -Path $PSScriptRoot

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Host "Git isn't installed or isn't on PATH. Get it from https://git-scm.com/download/win" -ForegroundColor Red
    exit 1
}

if (-not (Test-Path ".git")) {
    Write-Host "No git repo here yet - initializing..." -ForegroundColor Yellow
    git init | Out-Null
    git checkout -b $Branch | Out-Null
} else {
    $current = git branch --show-current
    if ($current) { $Branch = $current } else { git checkout -b $Branch | Out-Null }
}

$existingRemote = git remote get-url origin 2>$null
if ($existingRemote) {
    $originUrl = $existingRemote
} else {
    if (-not $RepoUrl) {
        $RepoUrl = Read-Host "No 'origin' remote set yet - paste your GitHub repo URL"
    }
    git remote add origin $RepoUrl
    $originUrl = $RepoUrl
    Write-Host "Added remote origin -> $RepoUrl" -ForegroundColor Green
}

git add -A
$staged = git diff --cached --name-only
if (-not $staged) {
    Write-Host "Nothing to commit - working tree matches the last commit." -ForegroundColor Yellow
} else {
    git commit -m $Message
    Write-Host "Committed: $Message" -ForegroundColor Green
}

git push -u origin $Branch

Write-Host "Done. Pushed to $originUrl ($Branch)." -ForegroundColor Cyan
