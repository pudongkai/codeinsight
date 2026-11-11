def index(request):
    return None


class ItemView:
    @classmethod
    def as_view(cls):
        return cls
