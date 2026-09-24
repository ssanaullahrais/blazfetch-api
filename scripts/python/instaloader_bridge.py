#!/usr/bin/env python
"""
Bridges Instaloader's Python API into Blazfetch's Node.js backend as a subprocess: given a
profile username and an optional saved session, it lists posts as JSON on stdout and exits.
It never downloads media to disk itself and never touches credentials directly - it only ever
loads a session file the operator already created themselves via `instaloader --login <user>`.

Usage:
    python instaloader_bridge.py <target_username> <max_items> [session_username] [session_file]

Output (stdout, single JSON line):
    {"username": "...", "itemCount": N, "items": [{"shortcode","url","isVideo","videoUrl",
     "displayUrl","caption","dateUtc","likes","commentCount"}, ...]}

Errors go to stdout as {"error": "<code>", "message": "..."} with a non-zero exit code, so the
Node side can classify them without scraping stderr text.
"""

import json
import sys


def emit_error(code: str, message: str) -> None:
    print(json.dumps({"error": code, "message": message}))
    sys.exit(1)


def main() -> None:
    if len(sys.argv) < 3:
        emit_error("BAD_ARGS", "usage: instaloader_bridge.py <username> <max_items> [session_username] [session_file]")

    target_username = sys.argv[1]
    try:
        max_items = int(sys.argv[2])
    except ValueError:
        emit_error("BAD_ARGS", "max_items must be an integer")
        return

    session_username = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] else None
    session_file = sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] else None

    try:
        import instaloader
    except ImportError:
        emit_error("NOT_INSTALLED", "instaloader is not installed (pip install instaloader)")
        return

    loader = instaloader.Instaloader(
        download_pictures=False,
        download_videos=False,
        download_video_thumbnails=False,
        download_geotags=False,
        download_comments=False,
        save_metadata=False,
        compress_json=False,
        quiet=True,
    )

    if session_username and session_file:
        try:
            loader.load_session_from_file(session_username, session_file)
        except FileNotFoundError:
            emit_error("SESSION_NOT_FOUND", f"session file not found: {session_file}")
            return
        except Exception as exc:  # noqa: BLE001 - surface any session load failure cleanly
            emit_error("SESSION_INVALID", f"failed to load session: {exc}")
            return

    try:
        profile = instaloader.Profile.from_username(loader.context, target_username)
    except instaloader.exceptions.ProfileNotExistsException:
        emit_error("MEDIA_NOT_FOUND", f"profile '{target_username}' does not exist")
        return
    except instaloader.exceptions.LoginRequiredException:
        emit_error("LOGIN_REQUIRED", "Instagram requires a logged-in session to view this profile")
        return
    except instaloader.exceptions.ConnectionException as exc:
        emit_error("PLATFORM_RATE_LIMITED", f"Instagram connection error (often rate-limiting): {exc}")
        return

    if profile.is_private and not (session_username and profile.followed_by_viewer):
        emit_error("PRIVATE_MEDIA", f"profile '{target_username}' is private and not accessible with the provided session")
        return

    items = []
    try:
        for post in profile.get_posts():
            if len(items) >= max_items:
                break
            items.append({
                "shortcode": post.shortcode,
                "url": f"https://www.instagram.com/p/{post.shortcode}/",
                "isVideo": bool(post.is_video),
                "videoUrl": post.video_url if post.is_video else None,
                "displayUrl": post.url,
                "caption": (post.caption or "")[:280] if post.caption else None,
                "dateUtc": post.date_utc.isoformat(),
                "likes": post.likes,
                "commentCount": post.comments,
            })
    except instaloader.exceptions.LoginRequiredException:
        if not items:
            emit_error("LOGIN_REQUIRED", "Instagram requires a logged-in session to list this profile's posts")
            return
        # Partial results before hitting the wall are still useful - fall through and return them.
    except instaloader.exceptions.ConnectionException as exc:
        if not items:
            emit_error("PLATFORM_RATE_LIMITED", f"Instagram connection error while listing posts: {exc}")
            return

    print(json.dumps({
        "username": target_username,
        "fullName": profile.full_name,
        "biography": profile.biography,
        "profilePicUrl": profile.profile_pic_url,
        "followerCount": profile.followers,
        "postCount": profile.mediacount,
        "itemCount": len(items),
        "items": items,
    }))


if __name__ == "__main__":
    main()
