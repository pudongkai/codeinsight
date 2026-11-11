from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()


@app.get("/items/{item_id}")
async def get_item(
    item_id: int,  # path param
    q: str | None = None,
) -> dict:
    return {"id": item_id}


@router.post("/orders")
def create_order():
    return {}


@app.api_route("/ping", methods=["GET", "HEAD"])
def ping():
    return "pong"


@app.exception_handler(ValueError)
async def on_value_error(request, exc):
    return None


@app.middleware("http")
async def add_header(request, call_next):
    return await call_next(request)


@app.on_event("startup")
def startup():
    pass
