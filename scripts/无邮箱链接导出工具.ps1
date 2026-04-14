chcp 65001 | Out-Null
$Host.UI.RawUI.WindowTitle = "无邮箱链接导出工具"

Write-Host ""
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host "    无邮箱链接导出工具" -ForegroundColor Cyan
Write-Host "  ========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  正在搜索 scrape-log.json ..."

$found = Get-ChildItem $env:APPDATA -Filter 'scrape-log.json' -Recurse -ErrorAction SilentlyContinue -Depth 3 | Select-Object -First 1

if (-not $found) {
    Write-Host "  未找到 scrape-log.json，请确认已运行过爬取任务" -ForegroundColor Red
    Read-Host "按回车退出"
    exit 1
}

Write-Host "  找到: $($found.FullName)" -ForegroundColor Green
Write-Host ""

$log = Get-Content $found.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
$scraped = $log.scraped
$props = $scraped.PSObject.Properties
$total = ($props | Measure-Object).Count

$rows = @()
foreach ($p in $props) {
    $url = $p.Name
    $e = $p.Value
    if (-not $e.email) {
        $bio = if ($e.bio) { ($e.bio -replace '[\r\n]+', ' ') } else { '' }
        $rows += [PSCustomObject]@{
            'TikTok链接' = $url
            '用户名'     = $(if($e.username){$e.username}else{''})
            '简介'       = $bio
            '错误信息'   = $(if($e.error){$e.error}else{''})
            '爬取时间'   = $(if($e.at){$e.at}else{''})
        }
    }
}

$withEmail = $total - $rows.Count
Write-Host "  总记录: $total 条  |  有邮箱: $withEmail 条  |  无邮箱: $($rows.Count) 条" -ForegroundColor Cyan
Write-Host ""

if ($rows.Count -eq 0) {
    Write-Host "  没有无邮箱的记录！" -ForegroundColor Yellow
    Read-Host "按回车退出"
    exit 0
}

$out = Join-Path ([Environment]::GetFolderPath('Desktop')) '无邮箱达人链接.csv'
$rows | Export-Csv -Path $out -NoTypeInformation -Encoding UTF8

Write-Host "  已导出到桌面: 无邮箱达人链接.csv ($($rows.Count) 条)" -ForegroundColor Green
Write-Host ""

Start-Process $out
Read-Host "按回车退出"
