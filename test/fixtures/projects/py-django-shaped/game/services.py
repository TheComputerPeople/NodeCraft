"""The game's services, which views call."""


def title(name: str) -> str:
    """@blueprint pure"""
    return name[:1].upper() + name[1:]
