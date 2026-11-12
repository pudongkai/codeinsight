import os

import psycopg_pool

DATABASE_URL = os.environ["DATABASE_URL"]
STRIPE_KEY = os.getenv("STRIPE_KEY")

pool = psycopg_pool.ConnectionPool(DATABASE_URL)
