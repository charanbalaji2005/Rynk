from fastapi import FastAPI

app = FastAPI()


@app.get("/")
def root():
    return {"message": "FastAPI on Rynk"}


@app.get("/health")
def health():
    return {"ok": True}
