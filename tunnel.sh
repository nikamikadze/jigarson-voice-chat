#!/bin/bash

# Check if ngrok is installed
if ! command -v ngrok &> /dev/null; then
    echo "⚠️  ngrok is not installed."
    echo "Please install it by running: brew install ngrok --cask"
    echo "Or download it from: https://dashboard.ngrok.com/get-started/setup/macos"
    exit 1
fi

# Load .env variables if .env exists
if [ -f .env ]; then
    # Extract NGROK variables (removing carriage returns if any)
    NGROK_AUTHTOKEN=$(grep -E "^NGROK_AUTHTOKEN=" .env | cut -d'=' -f2- | tr -d '\r')
    NGROK_DOMAIN=$(grep -E "^NGROK_DOMAIN=" .env | cut -d'=' -f2- | tr -d '\r')
fi

if [ -n "$NGROK_AUTHTOKEN" ]; then
    echo "🔐 Setting ngrok authtoken..."
    ngrok config add-authtoken "$NGROK_AUTHTOKEN"
fi

if [ -n "$NGROK_DOMAIN" ]; then
    echo "🚀 Starting ngrok tunnel with static domain: $NGROK_DOMAIN on port 9787..."
    ngrok http --url="$NGROK_DOMAIN" 9787
else
    echo "ℹ️  No NGROK_DOMAIN found in .env."
    echo "💡 We recommend signing up at https://dashboard.ngrok.com to get a FREE static domain and setting NGROK_DOMAIN and NGROK_AUTHTOKEN in your .env file."
    echo "🚀 Starting a dynamic ngrok tunnel on port 9787..."
    ngrok http 9787
fi
