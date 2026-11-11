from celery import Celery, shared_task

celery_app = Celery("demo")


@celery_app.task
def add(a, b):
    return a + b


@shared_task(bind=True, name="demo.mul")
def mul(self, a, b):
    return a * b
