"""Build RDF graphs from normalized Instagram data using rdflib.

Maps Instagram export data to ActivityStreams 2.0, SIOC, FOAF, and schema.org
ontologies. Each content type gets its own graph for modular Pod storage.

Privacy policy — read before adding builders:
    Only data that is *publicly visible on the source platform* AND not an
    aggregated activity log of the account holder is converted to RDF.
    Excluded categories — never emit triples for these:
        - DMs / messages
        - saved / bookmarks
        - search history
        - "liked posts" lists (private on Instagram, X, etc.)
        - the user's own comment history (aggregated activity log even if each
          comment is individually public on its source post)
        - EXIF GPS coordinates (source platforms strip these before display)
        - profile PII: email, phone, date of birth, gender

    If you add a new content type, document in the PR (a) why existing AS2
    types don't fit and (b) evidence that the data is publicly visible on the
    source profile page. Default is to NOT add a builder.
"""

from __future__ import annotations

import json
from pathlib import Path
from urllib.parse import quote

from rdflib import BNode, Graph, Literal, URIRef
from rdflib.namespace import RDF, XSD, FOAF

from .namespaces import AS, SIOC, SCHEMA, BW, bind_namespaces

BASE = "https://bridgingworlds.io/resource/"


def _uri(path: str) -> URIRef:
    return URIRef(f"{BASE}{path}")


def _user_uri(username: str) -> URIRef:
    return _uri(f"user/{quote(username, safe='')}")


def build_profile_graph(profile: dict) -> Graph:
    """Convert normalized profile to RDF."""
    g = Graph()
    bind_namespaces(g)

    username = profile.get("username", "")
    if not username:
        return g

    user = _user_uri(username)

    g.add((user, RDF.type, FOAF.Person))
    g.add((user, RDF.type, SIOC.UserAccount))
    g.add((user, FOAF.accountName, Literal(username)))
    g.add((user, AS.preferredUsername, Literal(username)))

    if profile.get("bio"):
        g.add((user, AS.summary, Literal(profile["bio"])))
        g.add((user, SCHEMA.description, Literal(profile["bio"])))

    # Email, phone, gender, and date_of_birth are NOT publicly visible on
    # Instagram — they live in the export but are private profile fields.
    # Do not emit them as RDF.

    if profile.get("profile_photo_uri"):
        g.add((user, FOAF.img, Literal(profile["profile_photo_uri"])))

    g.add((user, FOAF.homepage, URIRef(f"https://www.instagram.com/{username}")))

    return g


def build_posts_graph(posts: list[dict], username: str) -> Graph:
    """Convert normalized posts to RDF with AS2 Create activity wrapping."""
    g = Graph()
    bind_namespaces(g)

    user = _user_uri(username)

    for post in posts:
        post_uri = _uri(f"post/{post['id']}")
        activity_uri = _uri(f"activity/create/{post['id']}")

        # The Note (post content)
        g.add((post_uri, RDF.type, AS.Note))
        g.add((post_uri, RDF.type, SIOC.Post))
        g.add((post_uri, RDF.type, SCHEMA.SocialMediaPosting))

        if post.get("caption"):
            g.add((post_uri, AS.content, Literal(post["caption"])))
            g.add((post_uri, SCHEMA.articleBody, Literal(post["caption"])))

        if post.get("created_at"):
            g.add((post_uri, AS.published, Literal(post["created_at"], datatype=XSD.dateTime)))

        g.add((post_uri, AS.attributedTo, user))

        # Attachments
        for att in post.get("attachments", []):
            att_node = BNode()
            if att["type"] == "Video":
                g.add((att_node, RDF.type, AS.Video))
            else:
                g.add((att_node, RDF.type, AS.Image))
            g.add((att_node, AS.url, Literal(att["uri"])))
            g.add((post_uri, AS.attachment, att_node))

        # EXIF GPS coordinates from the original photo are NOT what Instagram
        # displays publicly — the platform strips them before render. Do not
        # leak them to RDF. (A user-tagged location is different and would be
        # public, but this pipeline only sees raw EXIF.)

        # Wrapping Create activity
        g.add((activity_uri, RDF.type, AS.Create))
        g.add((activity_uri, AS.actor, user))
        g.add((activity_uri, AS.object, post_uri))
        if post.get("created_at"):
            g.add((activity_uri, AS.published, Literal(post["created_at"], datatype=XSD.dateTime)))

        # Content type marker (post vs reel)
        if post.get("content_type"):
            g.add((post_uri, BW.contentType, Literal(post["content_type"])))

    return g


def build_followers_graph(followers: list[dict], username: str) -> Graph:
    """Convert followers to AS2 Follow activities (incoming)."""
    g = Graph()
    bind_namespaces(g)

    user = _user_uri(username)

    for i, follower in enumerate(followers):
        follow_uri = _uri(f"follow/in/{i}")
        follower_uri = _user_uri(follower["username"])

        g.add((follow_uri, RDF.type, AS.Follow))
        g.add((follow_uri, AS.actor, follower_uri))
        g.add((follow_uri, AS.object, user))

        if follower.get("followed_at"):
            g.add((follow_uri, AS.published, Literal(follower["followed_at"], datatype=XSD.dateTime)))

        g.add((follower_uri, RDF.type, FOAF.OnlineAccount))
        g.add((follower_uri, FOAF.accountName, Literal(follower["username"])))
        if follower.get("profile_url"):
            g.add((follower_uri, FOAF.homepage, URIRef(follower["profile_url"])))

    return g


def build_following_graph(following: list[dict], username: str) -> Graph:
    """Convert following to AS2 Follow activities (outgoing)."""
    g = Graph()
    bind_namespaces(g)

    user = _user_uri(username)

    for i, followed in enumerate(following):
        follow_uri = _uri(f"follow/out/{i}")
        followed_uri = _user_uri(followed["username"])

        g.add((follow_uri, RDF.type, AS.Follow))
        g.add((follow_uri, AS.actor, user))
        g.add((follow_uri, AS.object, followed_uri))

        if followed.get("followed_at"):
            g.add((follow_uri, AS.published, Literal(followed["followed_at"], datatype=XSD.dateTime)))

        g.add((followed_uri, RDF.type, FOAF.OnlineAccount))
        g.add((followed_uri, FOAF.accountName, Literal(followed["username"])))
        if followed.get("profile_url"):
            g.add((followed_uri, FOAF.homepage, URIRef(followed["profile_url"])))

    return g


def build_stories_graph(stories: list[dict], username: str) -> Graph:
    """Convert stories to AS2 Note resources with story marker."""
    g = Graph()
    bind_namespaces(g)

    user = _user_uri(username)

    for story in stories:
        story_uri = _uri(f"story/{story['id']}")

        g.add((story_uri, RDF.type, AS.Note))
        g.add((story_uri, BW.isStory, Literal(True, datatype=XSD.boolean)))
        g.add((story_uri, AS.attributedTo, user))

        if story.get("created_at"):
            g.add((story_uri, AS.published, Literal(story["created_at"], datatype=XSD.dateTime)))

        if story.get("title"):
            g.add((story_uri, AS.content, Literal(story["title"])))

        # Media attachment
        att_node = BNode()
        if story.get("type") == "Video":
            g.add((att_node, RDF.type, AS.Video))
        else:
            g.add((att_node, RDF.type, AS.Image))
        g.add((att_node, AS.url, Literal(story["uri"])))
        g.add((story_uri, AS.attachment, att_node))

        if story.get("music_genre"):
            g.add((story_uri, BW.musicGenre, Literal(story["music_genre"])))

    return g


def convert_all(normalized_dir: Path, output_dir: Path, username: str) -> dict[str, int]:
    """Convert all normalized JSON to RDF Turtle files. Returns triple counts."""
    output_dir.mkdir(parents=True, exist_ok=True)

    def _load(name: str):
        path = normalized_dir / f"{name}.json"
        if path.exists():
            with open(path) as f:
                return json.load(f)
        return [] if name != "profile" else {}

    # Public-only allowlist. Private and aggregated-activity types (likes,
    # comments, messages, saved, searches) are deliberately absent — they are
    # not converted to RDF. See the privacy policy in the module docstring.
    builders = {
        "profile": lambda: build_profile_graph(_load("profile")),
        "posts": lambda: build_posts_graph(_load("posts") + _load("reels"), username),
        "followers": lambda: build_followers_graph(_load("followers"), username),
        "following": lambda: build_following_graph(_load("following"), username),
        "stories": lambda: build_stories_graph(_load("stories"), username),
    }

    counts = {}
    for name, builder in builders.items():
        g = builder()
        out_path = output_dir / f"{name}.ttl"
        g.serialize(destination=str(out_path), format="turtle")
        counts[name] = len(g)

    return counts
