# Vexora account server. Passwords are stored only as PBKDF2 hashes.
# The database lives outside the site folder so it can never be downloaded.
$ErrorActionPreference = "Stop"
$root = "C:\Users\cesar\flagquest"
$dataDir = Join-Path $env:LOCALAPPDATA "vexora-data"
$dbPath = Join-Path $dataDir "db.json"
$outboxPath = Join-Path $dataDir "reset-outbox.txt"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null

$mutex = New-Object System.Threading.Mutex($false, "Local\VexoraAccounts")
$hits = @{}
$avatars = @("compass", "globe", "ship", "sun", "palm", "mountain", "star", "flag")
$modes = @("classic", "infinite", "timed", "world")

function New-Id {
  return [Guid]::NewGuid().ToString("n")
}

function As-Plain($value) {
  if ($null -eq $value) { return $null }
  if ($value -is [string]) { return $value }
  if ($value -is [datetime]) { return $value.ToUniversalTime().ToString("o") }
  if ($value -is [bool] -or $value -is [ValueType]) { return $value }
  if ($value -is [System.Management.Automation.PSCustomObject]) {
    $copy = @{}
    foreach ($prop in $value.PSObject.Properties) { $copy[$prop.Name] = As-Plain $prop.Value }
    return ,$copy
  }
  if ($value -is [System.Collections.IDictionary]) {
    $copy = @{}
    foreach ($key in @($value.Keys)) { $copy[$key] = As-Plain $value[$key] }
    return ,$copy
  }
  if ($value -is [System.Collections.IEnumerable]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in $value) { [void]$list.Add((As-Plain $item)) }
    return ,$list
  }
  return "$value"
}

function Ensure-List($obj, [string]$key) {
  $current = $null
  if ($obj -is [System.Collections.IDictionary] -and $obj.Contains($key)) { $current = $obj[$key] }
  $list = New-Object System.Collections.ArrayList
  if ($null -ne $current) {
    foreach ($item in @($current)) { if ($null -ne $item) { [void]$list.Add((As-Plain $item)) } }
  }
  $obj[$key] = $list
}

function Read-Db {
  if (-not (Test-Path $dbPath)) {
    return @{ users = (New-Object System.Collections.ArrayList); sessions = (New-Object System.Collections.ArrayList); resets = (New-Object System.Collections.ArrayList); requests = (New-Object System.Collections.ArrayList); notes = (New-Object System.Collections.ArrayList) }
  }
  $raw = [IO.File]::ReadAllText($dbPath, [Text.UTF8Encoding]::new($false))
  $parsed = As-Plain (ConvertFrom-Json $raw)
  foreach ($key in @("users", "sessions", "resets", "requests", "notes")) { Ensure-List $parsed $key }
  foreach ($user in @($parsed.users)) {
    Ensure-List $user "achievements"
    Ensure-List $user "history"
    if ($user.best -isnot [System.Collections.IDictionary]) { $user.best = @{} }
  }
  return $parsed
}

function Save-Db($db) {
  $text = $db | ConvertTo-Json -Depth 12 -Compress
  $temp = "$dbPath.tmp"
  [IO.File]::WriteAllText($temp, $text, [Text.UTF8Encoding]::new($false))
  if (Test-Path $dbPath) { Remove-Item $dbPath -Force }
  Move-Item $temp $dbPath
}

function With-Db([scriptblock]$work) {
  [void]$mutex.WaitOne()
  try {
    $db = Read-Db
    $result = & $work $db
    if ($result.save) { Save-Db $db }
    return $result
  } finally {
    [void]$mutex.ReleaseMutex()
  }
}

function New-Salt {
  $bytes = New-Object byte[] 16
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return $bytes
}

function New-Secret {
  $bytes = New-Object byte[] 32
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  return ([Convert]::ToBase64String($bytes)).TrimEnd("=").Replace("+", "-").Replace("/", "_")
}

function Hash-Password([string]$password, [byte[]]$salt) {
  $kdf = $null
  try {
    $sha = [Security.Cryptography.HashAlgorithmName]::SHA256
    $kdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($password, $salt, 150000, $sha)
  } catch {
    $kdf = New-Object Security.Cryptography.Rfc2898DeriveBytes($password, $salt, 150000)
  }
  return [Convert]::ToBase64String($kdf.GetBytes(32))
}

function Same-Text([string]$left, [string]$right) {
  $a = [Text.Encoding]::UTF8.GetBytes("$left")
  $b = [Text.Encoding]::UTF8.GetBytes("$right")
  if ($a.Length -ne $b.Length) { return $false }
  $diff = 0
  for ($i = 0; $i -lt $a.Length; $i++) { $diff = $diff -bor ($a[$i] -bxor $b[$i]) }
  return $diff -eq 0
}

function Hash-Token([string]$token) {
  $sha = [Security.Cryptography.SHA256]::Create()
  $bytes = $sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($token))
  return [Convert]::ToBase64String($bytes)
}

function Level-Of($xp) {
  $value = 0
  if ($xp) { $value = [int]$xp }
  return [Math]::Floor($value / 400) + 1
}

function Best-Map($user) {
  $best = $user.best
  if ($best -isnot [System.Collections.IDictionary]) { $best = @{} }
  $out = @{}
  foreach ($mode in $modes) {
    $row = $best[$mode]
    if ($row -isnot [System.Collections.IDictionary]) { $row = @{ score = 0; accuracy = 0; date = "" } }
    $out[$mode] = @{ score = [int]$row.score; accuracy = [int]$row.accuracy; date = "$($row.date)" }
  }
  return $out
}

function Public-User($user, [bool]$self) {
  $achievements = @()
  if ($user.achievements) { $achievements = @($user.achievements) }
  $profile = @{
    id = "$($user.id)"
    username = "$($user.username)"
    displayName = "$($user.displayName)"
    bio = "$($user.bio)"
    avatar = "$($user.avatar)"
    createdAt = "$($user.createdAt)"
    level = (Level-Of $user.xp)
    xp = [int]$user.xp
    played = [int]$user.played
    correct = [int]$user.correct
    answered = [int]$user.answered
    accuracy = $(if ([int]$user.answered -gt 0) { [int][Math]::Round(100 * [int]$user.correct / [int]$user.answered) } else { 0 })
    bestStreak = [int]$user.bestStreak
    best = (Best-Map $user)
    achievements = $achievements
  }
  if ($self) { $profile.email = "$($user.email)" }
  return $profile
}

function Add-Achievement($user, [string]$id) {
  if (-not $user.achievements) { $user.achievements = New-Object System.Collections.ArrayList }
  if ($user.achievements -isnot [System.Collections.ArrayList]) {
    $list = New-Object System.Collections.ArrayList
    foreach ($item in @($user.achievements)) { [void]$list.Add("$item") }
    $user.achievements = $list
  }
  if ($user.achievements -notcontains $id) { [void]$user.achievements.Add($id) }
}

function Add-Note($db, [string]$userId, [string]$kind, [string]$fromId, [string]$text) {
  [void]$db.notes.Add(@{
    id = (New-Id)
    userId = $userId
    kind = $kind
    fromId = $fromId
    text = $text
    read = $false
    createdAt = [DateTime]::UtcNow.ToString("o")
  })
}

function Find-User($db, [string]$id) {
  foreach ($user in @($db.users)) { if ("$($user.id)" -eq $id) { return $user } }
  return $null
}

function Allow($ip) {
  $now = [DateTime]::UtcNow
  $window = @()
  if ($hits.ContainsKey($ip)) { $window = @($hits[$ip] | Where-Object { ($_ -as [DateTime]) -gt $now.AddMinutes(-10) }) }
  if ($window.Count -ge 30) { return $false }
  $window += $now
  $hits[$ip] = $window
  return $true
}

function Send-Json($res, [int]$code, $obj) {
  $json = $obj | ConvertTo-Json -Depth 12 -Compress
  $bytes = [Text.Encoding]::UTF8.GetBytes($json)
  $res.StatusCode = $code
  $res.ContentType = "application/json; charset=utf-8"
  $res.Headers["Cache-Control"] = "no-store"
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Send-File($res, [string]$path) {
  $ext = [IO.Path]::GetExtension($path).ToLowerInvariant()
  $types = @{
    ".html" = "text/html; charset=utf-8"
    ".css" = "text/css; charset=utf-8"
    ".js" = "text/javascript; charset=utf-8"
    ".png" = "image/png"
    ".svg" = "image/svg+xml"
    ".ico" = "image/x-icon"
  }
  $bytes = [IO.File]::ReadAllBytes($path)
  $res.StatusCode = 200
  $res.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { "application/octet-stream" })
  $res.ContentLength64 = $bytes.Length
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

function Read-Body($req) {
  $encoding = [Text.Encoding]::UTF8
  $reader = New-Object IO.StreamReader($req.InputStream, $encoding)
  try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
  if ([string]::IsNullOrWhiteSpace($text)) { return @{} }
  if ($text.Length -gt 20000) { throw "body-too-large" }
  return As-Plain (ConvertFrom-Json $text)
}

function Field($body, [string]$name) {
  if ($body -is [System.Collections.IDictionary] -and $body.Contains($name) -and $null -ne $body[$name]) { return "$($body[$name])" }
  return ""
}

function Session-User($db, $req) {
  $cookie = "$($req.Headers["Cookie"])"
  if ($cookie -notmatch 'vexora_session=([^;]+)') { return $null }
  $token = [Uri]::UnescapeDataString($Matches[1])
  $hash = Hash-Token $token
  $now = [DateTime]::UtcNow
  foreach ($session in @($db.sessions)) {
    if ("$($session.tokenHash)" -ne $hash) { continue }
    $expires = [DateTime]::Parse("$($session.expires)").ToUniversalTime()
    if ($expires -le $now) { continue }
    return Find-User $db "$($session.userId)"
  }
  return $null
}

function Set-Session($res, $db, $user, [bool]$remember) {
  $token = New-Secret
  $days = $(if ($remember) { 30 } else { 1 })
  [void]$db.sessions.Add(@{
    tokenHash = (Hash-Token $token)
    userId = "$($user.id)"
    expires = [DateTime]::UtcNow.AddDays($days).ToString("o")
  })
  $cookie = "vexora_session=$token; HttpOnly; Path=/; SameSite=Lax; Max-Age=$([int]($days * 86400))"
  $res.Headers.Add("Set-Cookie", $cookie)
}

function Clear-Session($res, $db, $req) {
  $cookie = "$($req.Headers["Cookie"])"
  if ($cookie -match 'vexora_session=([^;]+)') {
    $hash = Hash-Token ([Uri]::UnescapeDataString($Matches[1]))
    $keep = New-Object System.Collections.ArrayList
    foreach ($session in @($db.sessions)) {
      if ("$($session.tokenHash)" -ne $hash) { [void]$keep.Add($session) }
    }
    $db.sessions = $keep
  }
  $res.Headers.Add("Set-Cookie", "vexora_session=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0")
}

function Handle-Api($req, $res) {
  $path = $req.Url.AbsolutePath
  $method = $req.HttpMethod.ToUpperInvariant()
  if ($method -ne "GET" -and "$($req.Headers["X-Vexora"])" -ne "1") {
    Send-Json $res 403 @{ error = "Pedido recusado." }
    return
  }
  $ip = "$($req.RemoteEndPoint.Address)"
  if (@("POST", "PATCH", "DELETE") -contains $method -and -not (Allow $ip)) {
    Send-Json $res 429 @{ error = "Muitas tentativas. Espere alguns minutos." }
    return
  }

  if ($path -eq "/api/health" -and $method -eq "GET") {
    Send-Json $res 200 @{ ok = $true }
    return
  }

  if ($path -eq "/api/register" -and $method -eq "POST") {
    $body = Read-Body $req
    $username = (Field $body "username").Trim()
    $email = (Field $body "email").Trim().ToLowerInvariant()
    $password = Field $body "password"
    $confirm = Field $body "confirm"
    if ($username -notmatch '^[A-Za-z0-9_.]{3,18}$') { Send-Json $res 400 @{ error = "O nome de usuário precisa ter de 3 a 18 letras, números, ponto ou _." }; return }
    if ($email -notmatch '^[^@\s]+@[^@\s]+\.[^@\s]+$') { Send-Json $res 400 @{ error = "Digite um e-mail válido." }; return }
    if ($password.Length -lt 8 -or $password.Length -gt 72) { Send-Json $res 400 @{ error = "A senha precisa ter entre 8 e 72 caracteres." }; return }
    if ($password -ne $confirm) { Send-Json $res 400 @{ error = "A confirmação da senha não confere." }; return }
    $result = With-Db {
      param($db)
      foreach ($user in @($db.users)) {
        if ("$($user.username)".ToLowerInvariant() -eq $username.ToLowerInvariant()) { return @{ save = $false; code = 409; body = @{ error = "Esse nome de usuário já está em uso." } } }
        if ("$($user.email)" -eq $email) { return @{ save = $false; code = 409; body = @{ error = "Esse e-mail já está cadastrado." } } }
      }
      $salt = New-Salt
      $user = @{
        id = (New-Id)
        username = $username
        displayName = $username
        email = $email
        passwordHash = (Hash-Password $password $salt)
        passwordSalt = [Convert]::ToBase64String($salt)
        bio = ""
        avatar = "compass"
        createdAt = [DateTime]::UtcNow.ToString("o")
        xp = 0
        played = 0
        correct = 0
        answered = 0
        bestStreak = 0
        best = @{}
        achievements = (New-Object System.Collections.ArrayList)
        history = (New-Object System.Collections.ArrayList)
      }
      [void]$db.users.Add($user)
      Set-Session $res $db $user $false
      return @{ save = $true; code = 200; body = @{ user = (Public-User $user $true) } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/login" -and $method -eq "POST") {
    $body = Read-Body $req
    $email = (Field $body "email").Trim().ToLowerInvariant()
    $password = Field $body "password"
    $rememberFlag = ""
    if ($body -is [System.Collections.IDictionary] -and $body.Contains("remember")) { $rememberFlag = "$($body["remember"])" }
    $remember = $rememberFlag -eq "true" -or $rememberFlag -eq "True"
    $result = With-Db {
      param($db)
      $found = $null
      foreach ($user in @($db.users)) { if ("$($user.email)" -eq $email) { $found = $user; break } }
      $ok = $false
      if ($found) {
        $salt = [Convert]::FromBase64String("$($found.passwordSalt)")
        $ok = Same-Text (Hash-Password $password $salt) "$($found.passwordHash)"
      } else {
        $dummy = New-Object byte[] 16
        [void](Hash-Password $password $dummy)
      }
      if (-not $ok) { return @{ save = $false; code = 401; body = @{ error = "E-mail ou senha incorretos." } } }
      Set-Session $res $db $found $remember
      return @{ save = $true; code = 200; body = @{ user = (Public-User $found $true) } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/logout" -and $method -eq "POST") {
    $result = With-Db {
      param($db)
      Clear-Session $res $db $req
      return @{ save = $true; code = 200; body = @{ ok = $true } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/forgot" -and $method -eq "POST") {
    $body = Read-Body $req
    $email = (Field $body "email").Trim().ToLowerInvariant()
    $result = With-Db {
      param($db)
      $found = $null
      foreach ($user in @($db.users)) { if ("$($user.email)" -eq $email) { $found = $user; break } }
      if ($found) {
        $token = New-Secret
        [void]$db.resets.Add(@{
          tokenHash = (Hash-Token $token)
          userId = "$($found.id)"
          expires = [DateTime]::UtcNow.AddMinutes(30).ToString("o")
          used = $false
        })
        $line = "{0}`t{1}`t{2}" -f [DateTime]::UtcNow.ToString("o"), $email, $token
        Add-Content -Path $outboxPath -Value $line -Encoding UTF8
      }
      return @{ save = [bool]$found; code = 200; body = @{ ok = $true; message = "Se esse e-mail estiver cadastrado, a recuperação fica disponível neste computador por 30 minutos." } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/reset" -and $method -eq "POST") {
    $body = Read-Body $req
    $token = Field $body "token"
    $password = Field $body "password"
    $confirm = Field $body "confirm"
    if ($password.Length -lt 8 -or $password.Length -gt 72) { Send-Json $res 400 @{ error = "A senha precisa ter entre 8 e 72 caracteres." }; return }
    if ($password -ne $confirm) { Send-Json $res 400 @{ error = "A confirmação da senha não confere." }; return }
    $result = With-Db {
      param($db)
      $hash = Hash-Token $token
      $now = [DateTime]::UtcNow
      $row = $null
      foreach ($reset in @($db.resets)) {
        if ("$($reset.tokenHash)" -ne $hash) { continue }
        if ("$($reset.used)" -eq "True" -or "$($reset.used)" -eq "true") { continue }
        $expires = [DateTime]::Parse("$($reset.expires)").ToUniversalTime()
        if ($expires -le $now) { continue }
        $row = $reset
        break
      }
      if (-not $row) { return @{ save = $false; code = 400; body = @{ error = "Esse link de recuperação expirou ou já foi usado." } } }
      $user = Find-User $db "$($row.userId)"
      if (-not $user) { return @{ save = $false; code = 400; body = @{ error = "Esse link de recuperação expirou ou já foi usado." } } }
      $salt = New-Salt
      $user.passwordSalt = [Convert]::ToBase64String($salt)
      $user.passwordHash = Hash-Password $password $salt
      $row.used = $true
      $keep = New-Object System.Collections.ArrayList
      foreach ($session in @($db.sessions)) {
        if ("$($session.userId)" -ne "$($user.id)") { [void]$keep.Add($session) }
      }
      $db.sessions = $keep
      Set-Session $res $db $user $false
      return @{ save = $true; code = 200; body = @{ user = (Public-User $user $true) } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  $meResult = With-Db {
    param($db)
    return @{ save = $false; user = (Session-User $db $req); db = $db }
  }
  $current = $meResult.user

  if ($path -eq "/api/me" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    Send-Json $res 200 @{ user = (Public-User $current $true) }
    return
  }

  if ($path -eq "/api/me" -and $method -eq "PATCH") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $body = Read-Body $req
    $display = (Field $body "displayName").Trim()
    $bio = (Field $body "bio").Trim()
    $avatar = (Field $body "avatar").Trim()
    if ($display.Length -lt 2 -or $display.Length -gt 24) { Send-Json $res 400 @{ error = "O nome de exibição precisa ter de 2 a 24 caracteres." }; return }
    if ($bio.Length -gt 140) { Send-Json $res 400 @{ error = "A descrição pode ter até 140 caracteres." }; return }
    if ($avatars -notcontains $avatar) { Send-Json $res 400 @{ error = "Escolha um dos avatares disponíveis." }; return }
    $result = With-Db {
      param($db)
      $user = Find-User $db "$($current.id)"
      if (-not $user) { return @{ save = $false; code = 401; body = @{ error = "Entre para continuar." } } }
      $user.displayName = $display
      $user.bio = $bio
      $user.avatar = $avatar
      return @{ save = $true; code = 200; body = @{ user = (Public-User $user $true) } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/matches" -and $method -eq "POST") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $body = Read-Body $req
    $mode = Field $body "mode"
    if ($modes -notcontains $mode) { Send-Json $res 400 @{ error = "Modo de jogo inválido." }; return }
    $total = [Math]::Max(0, [Math]::Min(400, [int](Field $body "total")))
    $correct = [Math]::Max(0, [Math]::Min($total, [int](Field $body "correct")))
    $score = [Math]::Max(0, [Math]::Min(200000, [int](Field $body "score")))
    $streak = [Math]::Max(0, [Math]::Min($total, [int](Field $body "streak")))
    if ($total -lt 1) { Send-Json $res 400 @{ error = "A partida não teve perguntas." }; return }
    $result = With-Db {
      param($db)
      $user = Find-User $db "$($current.id)"
      $xpGain = [Math]::Min(8000, ($correct * 25) + [Math]::Floor($score / 10))
      $user.xp = [int]$user.xp + $xpGain
      $user.played = [int]$user.played + 1
      $user.correct = [int]$user.correct + $correct
      $user.answered = [int]$user.answered + $total
      if ($streak -gt [int]$user.bestStreak) { $user.bestStreak = $streak }
      if ($user.best -isnot [System.Collections.IDictionary]) { $user.best = @{} }
      $previous = $user.best[$mode]
      $previousScore = 0
      if ($previous) { $previousScore = [int]$previous.score }
      if ($score -ge $previousScore) {
        $user.best[$mode] = @{ score = $score; accuracy = [int][Math]::Round(100 * $correct / $total); date = [DateTime]::UtcNow.ToString("o") }
      }
      if (-not $user.history -or $user.history -isnot [System.Collections.ArrayList]) {
        $history = New-Object System.Collections.ArrayList
        foreach ($item in @($user.history)) { if ($item) { [void]$history.Add($item) } }
        $user.history = $history
      }
      [void]$user.history.Insert(0, @{
        mode = $mode
        score = $score
        correct = $correct
        total = $total
        streak = $streak
        date = [DateTime]::UtcNow.ToString("o")
      })
      while ($user.history.Count -gt 30) { $user.history.RemoveAt($user.history.Count - 1) }
      Add-Achievement $user "primeira_partida"
      if ($streak -ge 5) { Add-Achievement $user "sequencia_5" }
      if ($streak -ge 10) { Add-Achievement $user "sequencia_10" }
      if ($score -ge 1000) { Add-Achievement $user "recorde_1000" }
      if ($mode -eq "classic" -and $correct -eq $total -and $total -ge 10) { Add-Achievement $user "classico_perfeito" }
      if ([int]$user.played -ge 10) { Add-Achievement $user "dez_partidas" }
      return @{ save = $true; code = 200; body = @{ user = (Public-User $user $true); xpGain = $xpGain } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/history" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $history = @()
    if ($current.history) { $history = @($current.history) }
    Send-Json $res 200 @{ history = $history }
    return
  }

  if ($path -eq "/api/ranking" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $mode = "$($req.QueryString["mode"])"
    $rows = New-Object System.Collections.ArrayList
    foreach ($user in @((Read-Db).users)) {
      $best = Best-Map $user
      $picked = $null
      if ($modes -contains $mode) {
        if ([int]$best[$mode].score -gt 0) { $picked = @{ mode = $mode; score = [int]$best[$mode].score; accuracy = [int]$best[$mode].accuracy; date = "$($best[$mode].date)" } }
      } else {
        foreach ($item in $modes) {
          if (-not $picked -or [int]$best[$item].score -gt [int]$picked.score) {
            if ([int]$best[$item].score -gt 0) { $picked = @{ mode = $item; score = [int]$best[$item].score; accuracy = [int]$best[$item].accuracy; date = "$($best[$item].date)" } }
          }
        }
      }
      if ($picked) {
        [void]$rows.Add(@{
          userId = "$($user.id)"
          name = "$($user.displayName)"
          username = "$($user.username)"
          avatar = "$($user.avatar)"
          level = (Level-Of $user.xp)
          mode = $picked.mode
          score = $picked.score
          accuracy = $picked.accuracy
          date = $picked.date
        })
      }
    }
    Send-Json $res 200 @{ ranking = @($rows) }
    return
  }

  if ($path -eq "/api/users/search" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $query = "$($req.QueryString["q"])".Trim().ToLowerInvariant()
    if ($query.Length -lt 2) { Send-Json $res 200 @{ users = @() }; return }
    $rows = New-Object System.Collections.ArrayList
    foreach ($user in @((Read-Db).users)) {
      if ("$($user.id)" -eq "$($current.id)") { continue }
      $hay = ("$($user.username) $($user.displayName)").ToLowerInvariant()
      if ($hay.Contains($query)) {
        [void]$rows.Add(@{ id = "$($user.id)"; username = "$($user.username)"; displayName = "$($user.displayName)"; avatar = "$($user.avatar)"; level = (Level-Of $user.xp) })
        if ($rows.Count -ge 12) { break }
      }
    }
    Send-Json $res 200 @{ users = @($rows) }
    return
  }

  if ($path -match '^/api/users/([a-f0-9]{32})$' -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $user = Find-User (Read-Db) $Matches[1]
    if (-not $user) { Send-Json $res 404 @{ error = "Jogador não encontrado." }; return }
    $self = "$($user.id)" -eq "$($current.id)"
    Send-Json $res 200 @{ user = (Public-User $user $self) }
    return
  }

  if ($path -eq "/api/friends" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $db = Read-Db
    $friends = New-Object System.Collections.ArrayList
    $incoming = New-Object System.Collections.ArrayList
    $outgoing = New-Object System.Collections.ArrayList
    foreach ($request in @($db.requests)) {
      $from = Find-User $db "$($request.fromId)"
      $to = Find-User $db "$($request.toId)"
      if (-not $from -or -not $to) { continue }
      $status = "$($request.status)"
      if ($status -eq "accepted" -and ("$($request.fromId)" -eq "$($current.id)" -or "$($request.toId)" -eq "$($current.id)")) {
        $other = $(if ("$($request.fromId)" -eq "$($current.id)") { $to } else { $from })
        [void]$friends.Add(@{ requestId = "$($request.id)"; user = (Public-User $other $false) })
      }
      if ($status -eq "pending" -and "$($request.toId)" -eq "$($current.id)") {
        [void]$incoming.Add(@{ requestId = "$($request.id)"; user = (Public-User $from $false) })
      }
      if ($status -eq "pending" -and "$($request.fromId)" -eq "$($current.id)") {
        [void]$outgoing.Add(@{ requestId = "$($request.id)"; user = (Public-User $to $false) })
      }
    }
    Send-Json $res 200 @{ friends = @($friends); incoming = @($incoming); outgoing = @($outgoing) }
    return
  }

  if ($path -eq "/api/friends" -and $method -eq "POST") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $body = Read-Body $req
    $targetId = Field $body "userId"
    if ($targetId -eq "$($current.id)") { Send-Json $res 400 @{ error = "Você não pode adicionar a si mesmo." }; return }
    $result = With-Db {
      param($db)
      $target = Find-User $db $targetId
      if (-not $target) { return @{ save = $false; code = 404; body = @{ error = "Jogador não encontrado." } } }
      foreach ($request in @($db.requests)) {
        $pair = ("$($request.fromId)" -eq "$($current.id)" -and "$($request.toId)" -eq $targetId) -or ("$($request.toId)" -eq "$($current.id)" -and "$($request.fromId)" -eq $targetId)
        if (-not $pair) { continue }
        if ("$($request.status)" -eq "accepted") { return @{ save = $false; code = 409; body = @{ error = "Vocês já são amigos." } } }
        if ("$($request.status)" -eq "pending" -and "$($request.fromId)" -eq "$($current.id)") { return @{ save = $false; code = 409; body = @{ error = "O pedido já foi enviado." } } }
        if ("$($request.status)" -eq "pending" -and "$($request.toId)" -eq "$($current.id)") {
          $request.status = "accepted"
          Add-Achievement $current "primeiro_amigo"
          Add-Achievement $target "primeiro_amigo"
          $me = Find-User $db "$($current.id)"
          Add-Achievement $me "primeiro_amigo"
          Add-Note $db $targetId "friend" "$($current.id)" "$($current.displayName) aceitou sua solicitação."
          return @{ save = $true; code = 200; body = @{ ok = $true; status = "accepted" } }
        }
      }
      [void]$db.requests.Add(@{
        id = (New-Id)
        fromId = "$($current.id)"
        toId = $targetId
        status = "pending"
        createdAt = [DateTime]::UtcNow.ToString("o")
      })
      Add-Note $db $targetId "request" "$($current.id)" "$($current.displayName) enviou uma solicitação de amizade."
      return @{ save = $true; code = 200; body = @{ ok = $true; status = "pending" } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -match '^/api/friends/([a-f0-9]{32})$' -and $method -eq "POST") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $requestId = $Matches[1]
    $body = Read-Body $req
    $action = Field $body "action"
    $result = With-Db {
      param($db)
      $request = $null
      foreach ($item in @($db.requests)) { if ("$($item.id)" -eq $requestId) { $request = $item; break } }
      if (-not $request -or "$($request.status)" -ne "pending") { return @{ save = $false; code = 404; body = @{ error = "Solicitação não encontrada." } } }
      $isRecipient = "$($request.toId)" -eq "$($current.id)"
      $isSender = "$($request.fromId)" -eq "$($current.id)"
      if ($action -eq "accept" -or $action -eq "decline") {
        if (-not $isRecipient) { return @{ save = $false; code = 403; body = @{ error = "Só quem recebeu pode responder." } } }
        $request.status = $(if ($action -eq "accept") { "accepted" } else { "declined" })
        if ($action -eq "accept") {
          $from = Find-User $db "$($request.fromId)"
          $to = Find-User $db "$($request.toId)"
          Add-Achievement $from "primeiro_amigo"
          Add-Achievement $to "primeiro_amigo"
          Add-Note $db "$($request.fromId)" "friend" "$($current.id)" "$($current.displayName) aceitou sua solicitação."
        }
        return @{ save = $true; code = 200; body = @{ ok = $true } }
      }
      if ($action -eq "cancel") {
        if (-not $isSender) { return @{ save = $false; code = 403; body = @{ error = "Só quem enviou pode cancelar." } } }
        $request.status = "cancelled"
        return @{ save = $true; code = 200; body = @{ ok = $true } }
      }
      return @{ save = $false; code = 400; body = @{ error = "Ação inválida." } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -match '^/api/friends/([a-f0-9]{32})$' -and $method -eq "DELETE") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $requestId = $Matches[1]
    $result = With-Db {
      param($db)
      $request = $null
      foreach ($item in @($db.requests)) { if ("$($item.id)" -eq $requestId) { $request = $item; break } }
      if (-not $request -or "$($request.status)" -ne "accepted") { return @{ save = $false; code = 404; body = @{ error = "Amizade não encontrada." } } }
      if ("$($request.fromId)" -ne "$($current.id)" -and "$($request.toId)" -ne "$($current.id)") {
        return @{ save = $false; code = 403; body = @{ error = "Você não participa dessa amizade." } }
      }
      $keep = New-Object System.Collections.ArrayList
      foreach ($item in @($db.requests)) { if ("$($item.id)" -ne $requestId) { [void]$keep.Add($item) } }
      $db.requests = $keep
      return @{ save = $true; code = 200; body = @{ ok = $true } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  if ($path -eq "/api/notifications" -and $method -eq "GET") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $rows = New-Object System.Collections.ArrayList
    foreach ($note in @((Read-Db).notes)) {
      if ("$($note.userId)" -eq "$($current.id)") { [void]$rows.Add(@{ id = "$($note.id)"; text = "$($note.text)"; read = [bool]$note.read; createdAt = "$($note.createdAt)" }) }
    }
    Send-Json $res 200 @{ notifications = @($rows) }
    return
  }

  if ($path -eq "/api/notifications/read" -and $method -eq "POST") {
    if (-not $current) { Send-Json $res 401 @{ error = "Entre para continuar." }; return }
    $result = With-Db {
      param($db)
      foreach ($note in @($db.notes)) {
        if ("$($note.userId)" -eq "$($current.id)") { $note.read = $true }
      }
      return @{ save = $true; code = 200; body = @{ ok = $true } }
    }
    Send-Json $res $result.code $result.body
    return
  }

  Send-Json $res 404 @{ error = "Não encontrado." }
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:8754/")
$listener.Start()
Write-Output "VEXORA_READY http://127.0.0.1:8754/"

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $req = $context.Request
  $res = $context.Response
  try {
    $path = $req.Url.AbsolutePath
    if ($path.StartsWith("/api/")) {
      Handle-Api $req $res
    } else {
      $relative = [Uri]::UnescapeDataString($path.TrimStart("/"))
      if ([string]::IsNullOrWhiteSpace($relative)) { $relative = "index.html" }
      $relative = $relative.Replace("/", "\")
      $full = [IO.Path]::GetFullPath((Join-Path $root $relative))
      $rootFull = [IO.Path]::GetFullPath($root)
      $blocked = $full.StartsWith((Join-Path $rootFull "server"), [StringComparison]::OrdinalIgnoreCase)
      if (-not $full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase) -or $blocked -or -not (Test-Path $full -PathType Leaf)) {
        $res.StatusCode = 404
        $missing = [Text.Encoding]::UTF8.GetBytes("Nao encontrado")
        $res.ContentLength64 = $missing.Length
        $res.OutputStream.Write($missing, 0, $missing.Length)
      } else {
        Send-File $res $full
      }
    }
  } catch {
    try {
      $detail = $_.Exception.ToString() + "`n" + $_.ScriptStackTrace
      Add-Content -Path (Join-Path $dataDir "server-error.txt") -Value ("---- " + [DateTime]::UtcNow.ToString("o") + "`n" + $detail) -Encoding UTF8
      Send-Json $res 500 @{ error = "Não foi possível concluir agora. Tente de novo." }
    } catch {}
  } finally {
    try { $res.OutputStream.Close() } catch {}
  }
}
