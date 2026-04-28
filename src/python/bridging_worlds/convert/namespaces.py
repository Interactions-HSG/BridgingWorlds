"""RDF namespace definitions for the BridgingWorlds ontology mapping."""

from rdflib import Namespace
from rdflib.namespace import RDF, RDFS, XSD, FOAF, DCTERMS

# ActivityStreams 2.0
AS = Namespace("https://www.w3.org/ns/activitystreams#")

# SIOC (Semantically-Interlinked Online Communities)
SIOC = Namespace("http://rdfs.org/sioc/ns#")

# schema.org
SCHEMA = Namespace("https://schema.org/")

# vCard
VCARD = Namespace("http://www.w3.org/2006/vcard/ns#")

# WGS84 Geo
GEO = Namespace("http://www.w3.org/2003/01/geo/wgs84_pos#")

# Solid
SOLID = Namespace("http://www.w3.org/ns/solid/terms#")

# LDP
LDP = Namespace("http://www.w3.org/ns/ldp#")

# BridgingWorlds project-specific
BW = Namespace("https://bridgingworlds.io/ns#")

# All namespace bindings for graph serialization
NAMESPACE_BINDINGS = {
    "as": AS,
    "sioc": SIOC,
    "foaf": FOAF,
    "schema": SCHEMA,
    "dct": DCTERMS,
    "vcard": VCARD,
    "geo": GEO,
    "solid": SOLID,
    "ldp": LDP,
    "bw": BW,
}


def bind_namespaces(graph):
    """Bind all project namespaces to an rdflib Graph."""
    for prefix, ns in NAMESPACE_BINDINGS.items():
        graph.bind(prefix, ns)
    return graph
