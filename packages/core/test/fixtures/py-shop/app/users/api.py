from fastapi import APIRouter
from pydantic import BaseModel

from app.users import service

router = APIRouter()


class UserOut(BaseModel):
    id: int
    email: str


@router.get("/users/{user_id}")
def get_user(user_id: int) -> UserOut:
    return UserOut(**service.get_user(user_id))
