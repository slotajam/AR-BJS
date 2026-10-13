# syntax=docker/dockerfile:1
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
RUN useradd --system --uid 10001 rip
COPY requirements.lock .
# Optional build secret "build_ca" for builds behind a TLS-intercepting proxy:
#   docker build --secret id=build_ca,src=/path/to/ca.pem ...
RUN --mount=type=secret,id=build_ca,required=false \
    if [ -f /run/secrets/build_ca ]; then export PIP_CERT=/run/secrets/build_ca; fi; \
    pip install --no-cache-dir -r requirements.lock
COPY alembic.ini pyproject.toml ./
COPY alembic ./alembic
COPY app ./app
COPY tests/fixtures ./tests/fixtures
USER rip
EXPOSE 8000
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers", "--forwarded-allow-ips", "*"]
