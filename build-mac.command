#!/bin/bash
# ==========================================
# Agent Charon — Mac 一键打包脚本
# 双击运行，自动完成所有步骤
# ==========================================

set -e
cd "$(dirname "$0")"

echo ""
echo "======================================"
echo "  Agent Charon Mac 打包工具"
echo "======================================"
echo ""

# 1. 检查/安装 Node.js
if ! command -v node &> /dev/null; then
    echo "[1/4] 未检测到 Node.js，正在安装..."
    if command -v brew &> /dev/null; then
        brew install node
    else
        echo ""
        echo "  请先安装 Node.js："
        echo "  打开浏览器访问 https://nodejs.org"
        echo "  下载 LTS 版本安装后，重新运行此脚本"
        echo ""
        read -p "按回车退出..."
        exit 1
    fi
else
    echo "[1/4] Node.js 已安装: $(node -v)"
fi

# 2. 安装依赖
echo "[2/4] 安装项目依赖（首次较慢，请耐心等待）..."
npm install --no-audit --no-fund 2>&1 | tail -1

# 3. 打包
echo "[3/4] 正在打包 Mac 安装包..."
npx electron-builder --mac 2>&1 | grep -E '•|⨯'

# 4. 完成
echo "[4/4] 打包完成！"
echo ""

# 查找产出文件
DMG=$(find dist/mac -name "*.dmg" 2>/dev/null | head -1)
ZIP=$(find dist/mac -name "*.zip" 2>/dev/null | head -1)

if [ -n "$DMG" ]; then
    echo "  安装包: $DMG"
    # 拷贝到桌面
    cp "$DMG" ~/Desktop/
    echo "  已拷贝到桌面！"
    # 打开所在目录
    open -R ~/Desktop/"$(basename "$DMG")"
elif [ -n "$ZIP" ]; then
    echo "  安装包: $ZIP"
    cp "$ZIP" ~/Desktop/
    echo "  已拷贝到桌面！"
    open -R ~/Desktop/"$(basename "$ZIP")"
else
    echo "  产出目录: dist/mac/"
    open dist/mac/
fi

echo ""
echo "======================================"
echo "  把桌面上的安装包发给对方即可"
echo "======================================"
echo ""
read -p "按回车退出..."
