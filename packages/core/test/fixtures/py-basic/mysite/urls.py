from django.urls import path, re_path

from . import views
from .views import ItemView

urlpatterns = [
    path("index/", views.index, name="index"),
    re_path(r"^items/$", ItemView.as_view()),
]
