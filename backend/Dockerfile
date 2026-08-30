# 微信云托管用的镜像（2026-08-25）。
#
# ⚠️ ADR-001 里「不用 Docker」那条没被推翻 —— 它说的是**本地开发**不引入 Docker
# （本地照旧 node src/server.js）。这个文件只给云托管的构建机用，
# 本地从来不需要 docker build。
#
# 两个容易翻车的点：
#   1. TZ 必须设 Asia/Shanghai。容器默认 UTC，而「今天 14:05」这类展示、
#      日志时间戳、recoverStuckTasks 的时间判断全在后端算 ——
#      差 8 小时不报错，只是所有时间都静静地错着。
#   2. .env 绝不进镜像（见 .dockerignore）。密钥全部走云托管控制台的「环境变量」。
FROM node:20-slim

ENV TZ=Asia/Shanghai
WORKDIR /app

# 先只拷 package*.json 再装依赖：代码改一行不至于重装全部依赖（Docker 层缓存）
COPY package*.json ./
# npmmirror：云托管构建机在国内，走官方源慢且偶尔超时
RUN npm ci --omit=dev --registry=https://registry.npmmirror.com

COPY . .

# 云托管在服务设置里指定端口，通过 PORT 环境变量传进来（config.js 读它，默认 3000）。
# 控制台把「端口」填 3000 就不用改任何东西。
EXPOSE 3000
CMD ["node", "src/server.js"]
