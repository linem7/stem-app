@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion

REM ============================================================
REM  一键：起后端 + 打开管理后台
REM
REM  双击就行。三个端口轮换：3000 被占就试 3100，再不行 3200。
REM  已经有后端在跑的话不会再起第二个，直接开浏览器。
REM
REM  这个窗口就是后端本体 —— 关掉窗口 = 关掉后端。
REM  后端起不来时报错留在窗口里，别急着关，那句话就是原因。
REM
REM  改了后端代码**必须重启**：在这个窗口按 Ctrl+C，再双击一次这个 bat。
REM  顺序别反 —— 它检测到后端还在跑时只会开浏览器、不起新的，
REM  于是「双击了、后台也打开了」，但跑的还是旧代码。
REM  （试过用 --watch 自动重启，会在生成过程中杀掉任务。见下面那段。）
REM ============================================================

title stem-app 后端

cd /d "%~dp0backend"

if not exist "src\server.js" (
  echo [x] 没找到 backend\src\server.js
  echo     这个 bat 要放在 stem-app 根目录下，跟 backend 文件夹并排。
  goto :die
)

where node >nul 2>&1
if errorlevel 1 (
  echo [x] 找不到 node，装了 Node.js 吗？
  goto :die
)

if not exist ".env" (
  echo [x] backend\.env 不在。没有它后端连不上数据库，也没有模型 key。
  goto :die
)

REM ---------- 挑一个能用的端口 ----------
set PICKED=
set REUSE=0

for %%P in (3000 3100 3200) do (
  if not defined PICKED (
    netstat -ano | findstr /c:"LISTENING" | findstr /c:":%%P " >nul
    if errorlevel 1 (
      REM 没人听这个端口，就用它
      set PICKED=%%P
    ) else (
      REM 有人在听 —— 先问一句是不是我们自己的后端。
      REM 是的话直接用它，不然会起第二个进程抢同一个数据库，
      REM 而且你改了后端代码却看着旧进程，怎么改都不生效。
      curl -s -m 2 http://127.0.0.1:%%P/healthz 2>nul | findstr /c:"stem-lesson-backend" >nul
      if errorlevel 1 (
        echo     %%P 被别的程序占着，换一个
      ) else (
        set PICKED=%%P
        set REUSE=1
      )
    )
  )
)

if not defined PICKED (
  echo [x] 3000 / 3100 / 3200 都被别的程序占着。
  echo     腾一个出来，或者改这个 bat 里那行 for %%%%P in ^(3000 3100 3200^) 换成别的端口。
  goto :die
)

REM ---------- 已经在跑：只开浏览器 ----------
if "!REUSE!"=="1" (
  echo.
  echo   后端已经在 !PICKED! 上跑着，不再起一个。
  echo   打开 http://localhost:!PICKED!/admin
  echo.
  start "" "http://localhost:!PICKED!/admin"
  REM 停两秒让你看见上面那两行。
  REM 用 ping 而不是 timeout：timeout 碰到输入被重定向就拒绝运行（在终端里跑会看到
  REM 「Input redirection is not supported」），而且 git bash 的 PATH 里还有个同名的 GNU timeout。
  "%SystemRoot%\System32\ping.exe" -n 3 127.0.0.1 >nul
  exit /b 0
)

REM ---------- 起后端 ----------
title stem-app 后端（端口 !PICKED!）
echo.
echo   端口 !PICKED! —— 正在起后端，起来了自动开浏览器
echo   后台地址 http://localhost:!PICKED!/admin
echo   本地开发账号 admin / 123456
echo.

REM 等它真活了再开浏览器：起太快点进去是「拒绝连接」，会以为 bat 坏了。
REM 最多等 40 秒（数据库刚醒的时候会慢）。
start "" /b powershell -NoProfile -Command ^
  "for($i=0;$i -lt 40;$i++){ try{ Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 'http://127.0.0.1:!PICKED!/healthz' | Out-Null; Start-Process 'http://localhost:!PICKED!/admin'; break } catch { Start-Sleep -Seconds 1 } }"

set PORT=!PICKED!

REM 🔴 **不要在这里加 --watch。** 2026-08-20 加过一次，当天就撤了。
REM
REM 理由不是洁癖，是实测：加上之后提交一张配图，日志里是
REM   10:44:03.345  task_enqueued img_118
REM   10:44:03.384  POST /51/images → 200
REM                 Restarting 'src/server.js'      ← 一秒内
REM 任务被重启当场杀掉，图片行永远停在 pending。
REM
REM 根因在 services/taskQueue.js 的文件头第一行就写着：
REM **「进程重启，排队中和执行中的任务会丢」** —— 队列在内存里。
REM 而生成一份教案要 20-30 秒、一张图 20-70 秒，
REM --watch 是在**任务进行中**开火的，手动重启是你在两次操作之间做的。
REM 换来的「不用记得重启」远抵不上「核心功能静默丢任务」。
REM
REM 真要边改边跑，就自己开一个终端 `npm run dev`（那个是 --watch），
REM 但别在生成教案或配图的时候保存后端文件。
node src\server.js

REM 走到这儿说明后端退出了（你按了 Ctrl+C，或者它自己崩了）
echo.
echo   后端已停止。
goto :die

:die
echo.
pause
exit /b 1
