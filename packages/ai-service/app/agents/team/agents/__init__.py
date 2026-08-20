"""Agent team package initialization.

Exports the three concrete Agents for use by the router and pipeline.
"""

from app.agents.team.agents.assistant import AssistantAgent
from app.agents.team.agents.base import AgentCapability, BaseAgent
from app.agents.team.agents.fullstack import FullstackAgent
from app.agents.team.agents.primary import PrimaryAgent

__all__ = [
    "AgentCapability",
    "BaseAgent",
    "PrimaryAgent",
    "FullstackAgent",
    "AssistantAgent",
]
