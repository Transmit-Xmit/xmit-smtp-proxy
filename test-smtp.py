#!/usr/bin/env python3
"""
Test script for xmit-mail SMTP server.

Usage:
    python3 test-smtp.py

Requires:
    - XMIT_API_KEY environment variable
    - XMIT_FROM_EMAIL environment variable (sender email)
    - XMIT_TO_EMAIL environment variable (recipient email)

Optional:
    - XMIT_SMTP_HOST (default: mail.xmit.sh)
    - XMIT_SMTP_PORT (default: 587)
"""
import os
import sys
import smtplib
from email.mime.text import MIMEText

def main():
    # Required environment variables
    api_key = os.environ.get("XMIT_API_KEY")
    from_email = os.environ.get("XMIT_FROM_EMAIL")
    to_email = os.environ.get("XMIT_TO_EMAIL")

    if not all([api_key, from_email, to_email]):
        print("Error: Missing required environment variables")
        print("  XMIT_API_KEY    - Your Transmit API key")
        print("  XMIT_FROM_EMAIL - Sender email address")
        print("  XMIT_TO_EMAIL   - Recipient email address")
        sys.exit(1)

    # Optional configuration
    smtp_host = os.environ.get("XMIT_SMTP_HOST", "mail.xmit.sh")
    smtp_port = int(os.environ.get("XMIT_SMTP_PORT", "587"))

    # Build message
    msg = MIMEText("Hi there! This is a test email sent via the xmit-mail SMTP server.")
    msg["Subject"] = "Test from xmit-mail SMTP"
    msg["From"] = from_email
    msg["To"] = to_email

    print(f"Connecting to {smtp_host}:{smtp_port}...")

    try:
        with smtplib.SMTP(smtp_host, smtp_port) as server:
            server.starttls()
            server.login("api", api_key)
            server.send_message(msg)
            print(f"Email sent successfully!")
            print(f"  From: {from_email}")
            print(f"  To:   {to_email}")
    except smtplib.SMTPAuthenticationError:
        print("Error: Authentication failed. Check your API key.")
        sys.exit(1)
    except smtplib.SMTPException as e:
        print(f"Error: SMTP error - {e}")
        sys.exit(1)
    except Exception as e:
        print(f"Error: {e}")
        sys.exit(1)

if __name__ == "__main__":
    main()
