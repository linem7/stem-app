@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  一键：起教师端前端 + 打开浏览器
REM
REM  双击就行。已经在跑的话不会再起一个，直接开浏览器。
REM
REM  这个窗口就是 vite 本体 —— 关掉窗口 = 关掉前端。
REM  前端起不来时报错留在窗口里，别急着关，那句话就是原因。
REM
REM  🔴 后端必须在 **3000**，不能是别的端口。
REM  vite.config.js 里 proxy 把 /v1 和 /local-images 写死转给 localhost:3000。
REM  后端跑在 3100 的话页面**照样打开**，只是每个接口都 404 ——
REM  看起来像前端坏了，其实是代理指向了一个没人听的端口。
REM  所以这个 bat 只认 3000，不做端口轮换（admin.bat 会轮换，那是它自己的事）。
REM
REM  改了前端代码不用重启，vite 自己热更新。改了**后端**代码要重启后端那个窗口。
REM ============================================================

title stem-app 教师端

cd /d "%~dp0frontend"

if not exist "vite.config.js" (
  echo [x] 没找到 frontend\vite.config.js
  echo     这个 bat 要放在 stem-app 根目录下，跟 frontend 文件夹并排。
  goto :die
)

where node >nul 2>&1
if errorlevel 1 (
  echo [x] 找不到 node，装了 Node.js 吗？
  goto :die
)

if not exist "node_modules\vite" (
  echo [x] frontend\node_modules 里没有 vite，依赖还没装。
  echo     先在 frontend 目录下跑一次：npm install
  echo     ⚠️ 必须在本地硬盘跑，虚拟盘（如 Google Drive）会报 EBADF。
  goto :die
)

REM ---------- 先看后端在不在 3000 ----------
set BEOK=0
netstat -ano | findstr /c:"LISTENING" | findstr /c:":3000 " >nul
if errorlevel 1 (
  echo.
  echo   3000 上没有后端，先把它起起来...
  REM 新开一个窗口跑后端。/d 指定工作目录，省掉一层嵌套引号。
  start "stem-app 后端（3000）" /d "%~dp0backend" cmd /k "set PORT=3000 && node src\server.js"
) else (
  REM 有人在听 3000 —— 先问一句是不是我们自己的后端。
  curl -s -m 2 http://127.0.0.1:3000/healthz 2>nul | findstr /c:"stem-lesson-backend" >nul
  if errorlevel 1 (
    echo [x] 3000 被别的程序占着，而 vite 的代理只认 3000。
    echo     腾出 3000 再来：netstat -ano ^| findstr :3000 查到 PID，再 taskkill /PID 那个号 /F
    goto :die
  ) else (
    set BEOK=1
    echo   后端已在 3000 上跑着。
  )
)

REM 等后端真活了再往下走：起太快的话前端第一批请求全是 502。
if "!BEOK!"=="0" (
  for /l %%I in (1,1,40) do (
    if "!BEOK!"=="0" (
      curl -s -m 1 http://127.0.0.1:3000/healthz 2>nul | findstr /c:"stem-lesson-backend" >nul
      if not errorlevel 1 (
        set BEOK=1
      ) else (
        "%SystemRoot%\System32\ping.exe" -n 2 127.0.0.1 >nul
      )
    )
  )
  if "!BEOK!"=="0" (
    echo [x] 等了 40 秒，后端还是没起来。
    echo     去那个新开的「stem-app 后端」窗口看报错 —— 多半是 backend\.env 或数据库。
    goto :die
  )
  echo   后端起来了。
)

REM ---------- 本地开发账号 ----------
REM DEV_FAKE_LOGIN 登进来的是全新老师，gate^(^) 判「还没激活」，首页会跳 /redeem，
REM 而那一页还没搬过来 —— 表现是「打开就白屏/跳到一个空页面」，很难猜到原因。
findstr /c:"VITE_DEV_OPENID" ".env.development.local" >nul 2>&1
if errorlevel 1 (
  echo.
  echo   [!] 还没有本地开发账号，主链路走不通（首页会跳 /redeem，那一页还没做）。
  echo       另开一个窗口跑：cd frontend ^&^& npm run dev:account
  echo       它把账号写进 .env.development.local，vite 自己重启，刷新浏览器即可。
  echo.
  "%SystemRoot%\System32\ping.exe" -n 4 127.0.0.1 >nul
)

REM ---------- 已经在跑：只开浏览器 ----------
REM 先在三个候选端口上找我们自己的 vite，找到就复用。
REM 判据用 index.html 里的 theme-color #FFFDF8 —— 纯 ASCII，
REM 拿中文标题去 findstr 会被控制台编码坑（chcp 65001 下时好时坏）。
set FOUND=
for %%P in (5173 5174 5175) do (
  if not defined FOUND (
    curl -s -m 2 http://127.0.0.1:%%P/ 2>nul | findstr /c:"#FFFDF8" >nul
    if not errorlevel 1 set FOUND=%%P
  )
)

if defined FOUND (
  echo.
  echo   教师端已经在 !FOUND! 上跑着，不再起一个。
  echo   打开 http://localhost:!FOUND!/
  echo.
  start "" "http://localhost:!FOUND!/"
  REM 停两秒让你看见上面那两行。
  REM 用 ping 而不是 timeout：timeout 碰到输入被重定向就拒绝运行。
  "%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul
  exit /b 0
)

REM ---------- 挑一个空端口 ----------
set PICKED=
for %%P in (5173 5174 5175) do (
  if not defined PICKED (
    netstat -ano | findstr /c:"LISTENING" | findstr /c:":%%P " >nul
    if errorlevel 1 set PICKED=%%P
  )
)

if not defined PICKED (
  echo [x] 5173 / 5174 / 5175 都被别的程序占着。
  echo     腾一个出来，或者改这个 bat 里那两行 for %%%%P in ^(5173 5174 5175^) 换成别的端口。
  goto :die
)

REM ---------- 起前端 ----------
REM 显式传 --port + --strictPort：不传的话 vite 被占了会自己往后挪，
REM 而我们已经先开了浏览器指向 PICKED —— 两个端口对不上就是「打开是拒绝连接」。
title stem-app 教师端（端口 !PICKED!）
echo.
echo   端口 !PICKED! —— 正在起前端，起来了自动开浏览器
echo   教师端地址 http://localhost:!PICKED!/
echo.
echo   拿真手机看：同一个 WiFi 下开 vite 下面那行 Network 的地址
echo   （Windows 防火墙第一次会弹窗，点「允许」）
echo.

start "" /b powershell -NoProfile -Command ^
  "for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:!PICKED!/' | Out-Null; Start-Process 'http://localhost:!PICKED!/'; break } catch { Start-Sleep -Seconds 1 } }"

REM call 不能省：npm 是 npm.cmd，不 call 的话这个 bat 到这儿就直接退出了，
REM 后面「已停止」那行永远看不到。
call npm run dev -- --port !PICKED! --strictPort

REM 走到这儿说明 vite 退出了（你按了 Ctrl+C，或者它自己崩了）
echo.
echo   前端已停止。（后端那个窗口还在跑，要停它自己去按 Ctrl+C）
goto :die

:die
echo.
pause
exit /b 1
